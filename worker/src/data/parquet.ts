// 直下のデータセット (town / rsdtdsp_blk / rsdtdsp_rsdt) の Parquet を R2 から Range で読む。
// 表は lg_code 順に並べてあるので、フッターの行グループごとの lg_code の最小・最大を見て、
// その市区町村が入る行グループだけを読む。DuckDB もカタログも使わない
import { decompress } from "fzstd";
import {
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
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
