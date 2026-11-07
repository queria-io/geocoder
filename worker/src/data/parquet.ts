// 直下のデータセットの Parquet を R2 から Range で読む。表は都道府県ごとのファイルに分かれ、ファイルの中は
// lg_code などの列の順に並べてある。フッターの行グループごとのその列の最小・最大を見て、値が入る行グループだけを読む。
// DuckDB もカタログも使わない
import { decompress } from "fzstd";
import {
  type AsyncBuffer,
  type Compressors,
  type Encoding,
  type FileMetaData,
  parquetMetadata,
  parquetReadObjects,
} from "hyparquet";

// 表は zstd で書いている (dbt_project.yml)。fzstd は純粋な JS なので Workers でそのまま動く
export const compressors: Compressors = { ZSTD: (input) => decompress(input) };

/** R2 はときどき一時的な内部エラー (10001) を返すので、1 回だけ叩き直す */
export const retryOnce = <T>(f: () => Promise<T>): Promise<T> => f().catch(() => f());

/** R2 のオブジェクトを、hyparquet が Range で読める形にする */
export const r2Buffer = (
  bucket: R2Bucket,
  key: string,
  byteLength: number,
  onRead?: (bytes: number, ms: number) => void,
): AsyncBuffer => ({
  byteLength,
  slice: async (start, end) => {
    // Workers の時計は I/O の間だけ進むので、ここで測れるのは R2 を待った時間だけ
    const t0 = Date.now();
    const object = await retryOnce(() =>
      bucket.get(key, { range: { offset: start, length: (end ?? byteLength) - start } }),
    );
    if (!object) throw new Error(`not found: ${key}`);
    const body = await object.arrayBuffer();
    onRead?.((end ?? byteLength) - start, Date.now() - t0);
    return body;
  },
});

export type RowRange = { rowStart: number; rowEnd: number };

type Value = string | number;

/**
 * 並べた列 (lg_code など) の値のどれかが入りうる行グループの行の範囲。行グループはファイルの中でその順に
 * 並ぶとは限らないので、当たった行グループを 1 つずつ返す。隣り合うものだけ 1 つにまとめる
 */
export const rowRangesFor = (
  metadata: FileMetaData,
  values: Value | readonly Value[],
  key = "lg_code",
): RowRange[] => {
  const column = metadata.schema.findIndex((s) => s.name === key) - 1;
  if (column < 0) throw new Error(`${key} の列がありません`);
  const wanted = typeof values === "object" ? values : [values];
  return metadata.row_groups.reduce<{ start: number; ranges: RowRange[] }>(
    ({ start, ranges }, group) => {
      const rows = Number(group.num_rows);
      const stats = group.columns[column]?.meta_data?.statistics;
      const lo = stats?.min_value ?? stats?.min;
      const hi = stats?.max_value ?? stats?.max;
      // 数の列 (area_id) は数として比較する。文字列にすると「10」が「9」より前になる
      const inside = wanted.some((value) =>
        typeof value === "number"
          ? (lo == null || Number(lo) <= value) && (hi == null || value <= Number(hi))
          : String(lo ?? "") <= value && value <= String(hi ?? "\uffff"),
      );
      const last = ranges.at(-1);
      const next = !inside
        ? ranges
        : last?.rowEnd === start
          ? [...ranges.slice(0, -1), { rowStart: last.rowStart, rowEnd: start + rows }]
          : [...ranges, { rowStart: start, rowEnd: start + rows }];
      return { start: start + rows, ranges: next };
    },
    { start: 0, ranges: [] },
  ).ranges;
};

export type Table = { file: AsyncBuffer; metadata: FileMetaData };

/** フッター (メタデータ＋末尾 8 バイト) をファイルの末尾から読む */
const readFooter = async (file: AsyncBuffer): Promise<ArrayBuffer> => {
  const tail = new DataView(await file.slice(file.byteLength - 8, file.byteLength));
  if (tail.getUint32(4, true) !== 0x31524150)
    throw new Error("parquet file invalid (footer != PAR1)");
  const length = tail.getUint32(0, true) + 8;
  return file.slice(file.byteLength - length, file.byteLength);
};

/** 開くときに残す列。sortKey は行グループを絞る列、columns は読む列 (省くと全部の列) */
export type Keep = { sortKey?: string; columns?: string[] };

/** 読むのに使わない値の代わりに入れる (値ごとに BigInt を持たない) */
const UNUSED = 0n;
const NO_ENCODINGS: Encoding[] = [];

/**
 * 読まない列のメタデータを捨てる。開いたファイルは isolate の中で持ち続けるので、全部の列の
 * メタデータと統計を持つとメモリ (上限 128 MB) を圧迫する。統計は sortKey の列のものだけを残す
 */
const compact = (metadata: FileMetaData, { sortKey, columns }: Keep = {}): FileMetaData => {
  // 列の名前の配列は行グループごとに同じものを指す (行グループの数だけ配列を持たない)
  const paths = new Map<string, string[]>();
  const shared = (path: string[]) => {
    const key = path.join(".");
    const hit = paths.get(key);
    if (hit) return hit;
    paths.set(key, path);
    return path;
  };
  return {
    ...metadata,
    key_value_metadata: undefined,
    row_groups: metadata.row_groups.map((group) => ({
      num_rows: group.num_rows,
      total_byte_size: group.total_byte_size,
      columns: group.columns
        .filter(
          ({ meta_data }) =>
            columns === undefined ||
            meta_data === undefined ||
            meta_data.path_in_schema[0] === sortKey ||
            columns.includes(meta_data.path_in_schema[0]),
        )
        // hyparquet が読むのに使うのは列の名前・型・圧縮・ページの位置と長さだけ
        .map(({ meta_data }) => ({
          file_offset: UNUSED,
          meta_data: meta_data && {
            type: meta_data.type,
            encodings: NO_ENCODINGS,
            path_in_schema: shared(meta_data.path_in_schema),
            codec: meta_data.codec,
            num_values: UNUSED,
            total_uncompressed_size: UNUSED,
            total_compressed_size: meta_data.total_compressed_size,
            data_page_offset: meta_data.data_page_offset,
            dictionary_page_offset: meta_data.dictionary_page_offset,
            statistics: meta_data.path_in_schema[0] === sortKey ? meta_data.statistics : undefined,
          },
        })),
    })),
  };
};

/** ファイルを開く (フッターだけを読む) */
export const openTable = async (file: AsyncBuffer, keep?: Keep): Promise<Table> => ({
  file,
  metadata: compact(parquetMetadata(await readFooter(file)), keep),
});

/** R2 のファイルを開く */
export const openR2Table = async (
  bucket: R2Bucket,
  key: string,
  onRead?: (bytes: number, ms: number) => void,
  keep?: Keep,
): Promise<Table> => {
  const head = await retryOnce(() => bucket.head(key));
  if (!head) throw new Error(`not found: ${key}`);
  return openTable(r2Buffer(bucket, key, head.size, onRead), keep);
};

/** 列の値を比べられる形にする。BIGINT の列 (area_id) は hyparquet が bigint で返すので数にする */
const valueOf = (v: unknown): Value | null =>
  typeof v === "string" || typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null;

/**
 * 並べた列 key が values のどれかである行を読む。値が同じ行グループに入っていても、その行グループは 1 回だけ読む。
 * 行グループごと読むので、ほかの値の行は読んだあとに落とす
 */
export const readWhere = async <T>(
  table: Table,
  key: string,
  values: Value | readonly Value[],
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => {
  const { file, metadata } = table;
  const wanted = new Set(typeof values === "object" ? values : [values]);
  if (wanted.size === 0) return [];
  const ranges = rowRangesFor(metadata, [...wanted], key);
  const names = new Set(metadata.schema.map((c) => c.name));
  onRows?.(ranges.reduce((n, r) => n + r.rowEnd - r.rowStart, 0));
  // 表に無い列は読まない (列を足した表を作り直す前でも読めるように)
  const cols = [key, ...columns.filter((c) => c !== key && names.has(c))];
  return (
    await Promise.all(
      ranges.map((range) =>
        parquetReadObjects({ file, metadata, columns: cols, compressors, ...range }),
      ),
    )
  )
    .flat()
    .filter((row) => {
      const v = valueOf(row[key]);
      return v !== null && wanted.has(v);
    }) as T[];
};

/** 市区町村 1 つ分の行を読む */
export const readCity = <T extends { lg_code: string }>(
  table: Table,
  lgCode: string,
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => readWhere<T>(table, "lg_code", lgCode, columns, onRows);
