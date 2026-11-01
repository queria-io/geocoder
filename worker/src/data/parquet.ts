// 直下のデータセット (town / rsdtdsp_blk / rsdtdsp_rsdt) の Parquet を R2 から Range で読む。
// 表は lg_code 順に並べてあるので、フッターの行グループごとの lg_code の最小・最大を見て、
// その市区町村が入る行グループだけを読む。DuckDB もカタログも使わない
import { decompress } from "fzstd";
import {
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
  parquetMetadata,
  parquetMetadataAsync,
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

/**
 * 並べた列 (lg_code など) の値が入りうる行グループの行の範囲。行グループはファイルの中でその順に
 * 並ぶとは限らない (書き手が並行に書く) ので、当たった行グループを 1 つずつ返す。隣り合うものだけ 1 つにまとめる
 */
export const rowRangesFor = (
  metadata: FileMetaData,
  value: string,
  key = "lg_code",
): RowRange[] => {
  const column = metadata.schema.findIndex((s) => s.name === key) - 1;
  if (column < 0) throw new Error(`${key} の列がありません`);
  return metadata.row_groups.reduce<{ start: number; ranges: RowRange[] }>(
    ({ start, ranges }, group) => {
      const rows = Number(group.num_rows);
      const stats = group.columns[column]?.meta_data?.statistics;
      const min = String(stats?.min_value ?? stats?.min ?? "");
      const max = String(stats?.max_value ?? stats?.max ?? "\uffff");
      const last = ranges.at(-1);
      const next = !(min <= value && value <= max)
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

const FOOTER_CACHE = "https://geocoder.cache/parquet-footer/";

/**
 * R2 のファイルを開く。フッターはデータセンターのキャッシュ (Cache API) に置き、
 * 起動したての isolate でも R2 から読み直さない。ファイル名にバージョンの ID が入り
 * 中身は書き換わらないので、名前を鍵にしてよい
 */
export const openR2Table = async (
  bucket: R2Bucket,
  key: string,
  onRead?: (bytes: number, ms: number) => void,
): Promise<Table> => {
  const cacheKey = new Request(FOOTER_CACHE + encodeURIComponent(key));
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    const size = Number(hit.headers.get("x-file-size"));
    return {
      file: r2Buffer(bucket, key, size, onRead),
      metadata: parquetMetadata(await hit.arrayBuffer()),
    };
  }
  const head = await retryOnce(() => bucket.head(key));
  if (!head) throw new Error(`not found: ${key}`);
  const file = r2Buffer(bucket, key, head.size, onRead);
  const footer = await readFooter(file);
  await caches.default.put(
    cacheKey,
    new Response(footer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=2592000",
        "x-file-size": String(head.size),
      },
    }),
  );
  return { file, metadata: parquetMetadata(footer) };
};

/** ファイルを開く (フッターだけを読む)。結果は呼び出し側で isolate の中に使い回す */
export const openTable = async (file: AsyncBuffer): Promise<Table> => ({
  file,
  metadata: await parquetMetadataAsync(file),
});

/** 並べた列 key が value の行を読む。行グループごと読むので、ほかの値の行は読んだあとに落とす */
export const readWhere = async <T>(
  { file, metadata }: Table,
  key: string,
  value: string,
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => {
  const ranges = rowRangesFor(metadata, value, key);
  const names = new Set(metadata.schema.map((c) => c.name));
  onRows?.(ranges.reduce((n, r) => n + r.rowEnd - r.rowStart, 0));
  const read = (range: RowRange) =>
    parquetReadObjects({
      file,
      metadata,
      // 表に無い列は読まない (列を足した表を作り直す前でも読めるように)
      columns: [key, ...columns.filter((c) => c !== key && names.has(c))],
      compressors,
      ...range,
    }) as Promise<Record<string, unknown>[]>;
  return (await Promise.all(ranges.map(read))).flat().filter((row) => row[key] === value) as T[];
};

/** 市区町村 1 つ分の行を読む */
export const readCity = <T extends { lg_code: string }>(
  table: Table,
  lgCode: string,
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => readWhere<T>(table, "lg_code", lgCode, columns, onRows);
