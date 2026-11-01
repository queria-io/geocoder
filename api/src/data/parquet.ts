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

/** R2 のオブジェクトを、hyparquet が Range で読める形にする */
export const r2Buffer = (bucket: R2Bucket, key: string, byteLength: number): AsyncBuffer => ({
  byteLength,
  slice: async (start, end) => {
    const object = await bucket.get(key, {
      range: { offset: start, length: (end ?? byteLength) - start },
    });
    if (!object) throw new Error(`not found: ${key}`);
    return object.arrayBuffer();
  },
});

export type RowRange = { rowStart: number; rowEnd: number };

/**
 * lg_code が入りうる行グループの行の範囲。行グループは lg_code 順に並び重ならないので、
 * 当たる行グループは続いた 1 か所になる。範囲を 1 つにまとめて返し、無ければ null
 */
export const rowRangeFor = (metadata: FileMetaData, lgCode: string): RowRange | null => {
  const column = metadata.schema.findIndex((s) => s.name === "lg_code") - 1;
  if (column < 0) throw new Error("lg_code の列がありません");
  const groups = metadata.row_groups.reduce<{ start: number; ranges: RowRange[] }>(
    ({ start, ranges }, group) => {
      const rows = Number(group.num_rows);
      const stats = group.columns[column]?.meta_data?.statistics;
      const min = String(stats?.min_value ?? stats?.min ?? "");
      const max = String(stats?.max_value ?? stats?.max ?? "￿");
      const hit = min <= lgCode && lgCode <= max;
      return {
        start: start + rows,
        ranges: hit ? [...ranges, { rowStart: start, rowEnd: start + rows }] : ranges,
      };
    },
    { start: 0, ranges: [] },
  ).ranges;
  return groups.length === 0
    ? null
    : { rowStart: groups[0].rowStart, rowEnd: groups[groups.length - 1].rowEnd };
};

export type Table = { file: AsyncBuffer; metadata: FileMetaData };

/** ファイルを開く (フッターだけを読む)。結果は呼び出し側で isolate の中に使い回す */
export const openTable = async (file: AsyncBuffer): Promise<Table> => ({
  file,
  metadata: await parquetMetadataAsync(file),
});

/** 市区町村 1 つ分の行を読む。行グループごと読むので、隣の市区町村の行は読んだあとに落とす */
export const readCity = async <T extends { lg_code: string }>(
  { file, metadata }: Table,
  lgCode: string,
  columns: string[],
): Promise<T[]> => {
  const range = rowRangeFor(metadata, lgCode);
  if (!range) return [];
  const rows = (await parquetReadObjects({
    file,
    metadata,
    columns: columns.includes("lg_code") ? columns : ["lg_code", ...columns],
    compressors,
    ...range,
  })) as T[];
  return rows.filter((row) => row.lg_code === lgCode);
};
