// 直下のデータセット (town / rsdtdsp_blk / rsdtdsp_rsdt) の Parquet を R2 から Range で読む。
// 表は lg_code 順に並べてあるので、フッターの行グループごとの lg_code の最小・最大を見て、
// その市区町村が入る行グループだけを読む。DuckDB もカタログも使わない
import { decompress } from "fzstd";
import {
  type AsyncBuffer,
  type Compressors,
  type Encoding,
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
  value: string | number,
  key = "lg_code",
): RowRange[] => {
  const column = metadata.schema.findIndex((s) => s.name === key) - 1;
  if (column < 0) throw new Error(`${key} の列がありません`);
  return metadata.row_groups.reduce<{ start: number; ranges: RowRange[] }>(
    ({ start, ranges }, group) => {
      const rows = Number(group.num_rows);
      const stats = group.columns[column]?.meta_data?.statistics;
      const lo = stats?.min_value ?? stats?.min;
      const hi = stats?.max_value ?? stats?.max;
      // 数の列 (area_id) は数として比較する。文字列にすると「10」が「9」より前になる
      const inside =
        typeof value === "number"
          ? (lo == null || Number(lo) <= value) && (hi == null || value <= Number(hi))
          : String(lo ?? "") <= value && value <= String(hi ?? "\uffff");
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

/**
 * 読まない列のメタデータを捨てる。表によっては行グループが数千あり、全部の列のメタデータと統計を
 * 持つと isolate のメモリ (上限 128 MB) の半分を使う。統計は sortKey の列のものだけを残す
 */
/** 読むのに使わない値の代わりに入れる (値ごとに BigInt を持たない) */
const UNUSED = 0n;
const NO_ENCODINGS: Encoding[] = [];

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
  keep?: Keep,
): Promise<Table> => {
  const cacheKey = new Request(FOOTER_CACHE + encodeURIComponent(key));
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    const size = Number(hit.headers.get("x-file-size"));
    return {
      file: r2Buffer(bucket, key, size, onRead),
      metadata: compact(parquetMetadata(await hit.arrayBuffer()), keep),
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
  return { file, metadata: compact(parquetMetadata(footer), keep) };
};

/** ファイルを開く (フッターだけを読む)。結果は呼び出し側で isolate の中に使い回す */
export const openTable = async (file: AsyncBuffer): Promise<Table> => ({
  file,
  metadata: await parquetMetadataAsync(file),
});

/** 問い合わせの間だけ持つ入れ物。endRequest で空にする */
const scoped = new Set<{ clear: () => void }>();

/**
 * 問い合わせの間だけ値を覚える Map を作る。町字の行や展開した行グループは大きく、問い合わせを
 * またいで持つと isolate のメモリの上限 (128 MB) を超え、isolate が作り直されて毎回読み直しになる
 */
export const requestScoped = <K, V>(): Map<K, V> => {
  const m = new Map<K, V>();
  scoped.add(m);
  return m;
};

/** requestScoped の Map を空にする。問い合わせの初めと、答える前に呼ぶ */
export const endRequest = () => {
  for (const m of scoped) m.clear();
};

/**
 * 読んで展開した行グループ。1 つの行グループに町字がいくつも入るので、町字ごとに引くと
 * 同じ行グループを何度も読んで展開することになる
 */
const decoded = requestScoped<Table, Map<string, Promise<Record<string, unknown>[]>>>();

const remember = (
  table: Table,
  id: string,
  read: () => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> => {
  const kept = decoded.get(table) ?? new Map<string, Promise<Record<string, unknown>[]>>();
  decoded.set(table, kept);
  const hit = kept.get(id);
  if (hit) return hit;
  const p = read();
  kept.set(id, p);
  p.catch(() => kept.delete(id));
  return p;
};

/** 並べた列 key が value の行を読む。行グループごと読むので、ほかの値の行は読んだあとに落とす */
export const readWhere = async <T>(
  table: Table,
  key: string,
  value: string | number,
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => {
  const { file, metadata } = table;
  const ranges = rowRangesFor(metadata, value, key);
  const names = new Set(metadata.schema.map((c) => c.name));
  onRows?.(ranges.reduce((n, r) => n + r.rowEnd - r.rowStart, 0));
  // 表に無い列は読まない (列を足した表を作り直す前でも読めるように)
  const cols = [key, ...columns.filter((c) => c !== key && names.has(c))];
  const read = (range: RowRange) =>
    remember(table, `${range.rowStart}-${range.rowEnd}:${cols.join(",")}`, () =>
      parquetReadObjects({ file, metadata, columns: cols, compressors, ...range }),
    );
  return (await Promise.all(ranges.map(read)))
    .flat()
    .filter((row) => (typeof value === "number" ? Number(row[key]) : row[key]) === value) as T[];
};

/** 市区町村 1 つ分の行を読む */
export const readCity = <T extends { lg_code: string }>(
  table: Table,
  lgCode: string,
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => readWhere<T>(table, "lg_code", lgCode, columns, onRows);
