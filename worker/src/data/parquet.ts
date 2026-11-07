// 直下のデータセットの Parquet を R2 から Range で読む。表は lg_code などの列の順に並べてあるので、
// フッターの行グループごとのその列の最小・最大を見て、値が入る行グループだけを読む。DuckDB もカタログも使わない
import { decompress } from "fzstd";
import {
  type AsyncBuffer,
  type ColumnChunk,
  type CompressionCodec,
  type Compressors,
  type FileMetaData,
  type ParquetType,
  parquetMetadata,
  parquetReadObjects,
  type SchemaElement,
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

/** 開くときに残す列。sortKey は行グループを絞る列、columns は読む列 (省くと全部の列) */
export type Keep = { sortKey?: string; columns?: string[] };

/** 列の位置と長さ。dict は辞書のページの位置 (無ければ null) */
type Chunk = [data: number, dict: number | null, size: number];
/** 行グループ 1 つ。min・max は sortKey の列の値 (統計が無ければ null) */
type Group = [rows: number, min: string | number | null, max: string | number | null, Chunk[]];

/**
 * 表を読むのに要る値だけを抜き出したフッター。Parquet のフッターは行グループごとに全部の列の統計を持ち、
 * 大きな表では数 MB になる。解析に数百 ms かかり、全部を持つと isolate のメモリ (上限 128 MB) を圧迫する。
 * この形は JSON のままデータセンターのキャッシュに置き、起動したての isolate はフッターを解析し直さない
 */
export type TableIndex = {
  version: number;
  schema: SchemaElement[];
  sortKey: string | null;
  columns: { path: string[]; type: ParquetType; codec: CompressionCodec }[];
  groups: Group[];
};

export type Table = { file: AsyncBuffer; index: TableIndex };

// BigInt は JSON にできないので数にする (ファイルの位置も行数も 2^53 を超えない)
const plain = (v: unknown): string | number | null =>
  v === undefined || v === null
    ? null
    : typeof v === "bigint"
      ? Number(v)
      : typeof v === "number"
        ? v
        : String(v);

/** フッターから TableIndex を作る */
export const indexOf = (metadata: FileMetaData, { sortKey, columns }: Keep = {}): TableIndex => {
  const keep = (path: string) =>
    columns === undefined || path === sortKey || columns.includes(path);
  const first = metadata.row_groups[0]?.columns ?? [];
  const picked = first.flatMap((c, i) => {
    const m = c.meta_data;
    if (!m) throw new Error("parquet column metadata is undefined");
    // 入れ子の列 (リスト) は物理的な列が path_in_schema で分かれる。読む・読まないは一番上の名前で決める
    return keep(m.path_in_schema[0])
      ? [{ i, path: m.path_in_schema, type: m.type, codec: m.codec }]
      : [];
  });
  const sortAt =
    sortKey === undefined ? -1 : first.findIndex((c) => c.meta_data?.path_in_schema[0] === sortKey);
  if (sortKey !== undefined && sortAt < 0) throw new Error(`${sortKey} の列がありません`);
  return {
    version: metadata.version,
    schema: metadata.schema,
    sortKey: sortKey ?? null,
    columns: picked.map(({ path, type, codec }) => ({ path, type, codec })),
    groups: metadata.row_groups.map((g) => {
      const stats = sortAt < 0 ? undefined : g.columns[sortAt]?.meta_data?.statistics;
      return [
        Number(g.num_rows),
        plain(stats?.min_value ?? stats?.min),
        plain(stats?.max_value ?? stats?.max),
        picked.map(({ i, path }): Chunk => {
          const m = g.columns[i]?.meta_data;
          if (m === undefined || m.path_in_schema.join(".") !== path.join("."))
            throw new Error(`行グループごとに列の並びが違います: ${path.join(".")}`);
          return [
            Number(m.data_page_offset),
            m.dictionary_page_offset === undefined ? null : Number(m.dictionary_page_offset),
            Number(m.total_compressed_size),
          ];
        }),
      ];
    }),
  };
};

/** 行グループ 1 つだけを持つフッターに戻す。hyparquet に渡して、その行グループを読む */
const metadataOf = (index: TableIndex, [rows, , , chunks]: Group): FileMetaData => ({
  version: index.version,
  schema: index.schema,
  num_rows: BigInt(rows),
  metadata_length: 0,
  row_groups: [
    {
      num_rows: BigInt(rows),
      total_byte_size: 0n,
      columns: chunks.map(([data, dict, size], i): ColumnChunk => {
        const { path, type, codec } = index.columns[i];
        return {
          file_offset: 0n,
          meta_data: {
            type,
            encodings: [],
            path_in_schema: path,
            codec,
            num_values: 0n,
            total_uncompressed_size: 0n,
            total_compressed_size: BigInt(size),
            data_page_offset: BigInt(data),
            dictionary_page_offset: dict === null ? undefined : BigInt(dict),
          },
        };
      }),
    },
  ],
});

/**
 * sortKey の値が入りうる行グループの番号。行グループはファイルの中でその順に並ぶとは限らない
 * (書き手が並行に書く) ので、全部の行グループの最小・最大を見る
 */
export const groupsFor = (index: TableIndex, value: string | number): number[] =>
  index.groups.flatMap(([, lo, hi], i) => {
    // 数の列 (area_id) は数として比較する。文字列にすると「10」が「9」より前になる
    const inside =
      typeof value === "number"
        ? (lo === null || Number(lo) <= value) && (hi === null || value <= Number(hi))
        : String(lo ?? "") <= value && value <= String(hi ?? "\uffff");
    return inside ? [i] : [];
  });

/** フッター (メタデータ＋末尾 8 バイト) をファイルの末尾から読む */
const readFooter = async (file: AsyncBuffer): Promise<ArrayBuffer> => {
  const tail = new DataView(await file.slice(file.byteLength - 8, file.byteLength));
  if (tail.getUint32(4, true) !== 0x31524150)
    throw new Error("parquet file invalid (footer != PAR1)");
  const length = tail.getUint32(0, true) + 8;
  return file.slice(file.byteLength - length, file.byteLength);
};

const INDEX_CACHE = "https://geocoder.cache/parquet-index/v1/";

/**
 * R2 のファイルを開く。TableIndex はデータセンターのキャッシュ (Cache API) に置き、起動したての isolate でも
 * フッターを R2 から読み直さず、解析もし直さない。ファイル名にバージョンの ID が入り中身は書き換わらないので、
 * 名前と残す列を鍵にしてよい
 */
export const openR2Table = async (
  bucket: R2Bucket,
  key: string,
  onRead?: (bytes: number, ms: number) => void,
  keep: Keep = {},
): Promise<Table> => {
  const cacheKey = new Request(
    INDEX_CACHE +
      encodeURIComponent(key) +
      `?sort=${encodeURIComponent(keep.sortKey ?? "")}&columns=${encodeURIComponent(keep.columns?.join(",") ?? "*")}`,
  );
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    const size = Number(hit.headers.get("x-file-size"));
    return { file: r2Buffer(bucket, key, size, onRead), index: await hit.json<TableIndex>() };
  }
  const head = await retryOnce(() => bucket.head(key));
  if (!head) throw new Error(`not found: ${key}`);
  const file = r2Buffer(bucket, key, head.size, onRead);
  const index = indexOf(parquetMetadata(await readFooter(file)), keep);
  await caches.default.put(
    cacheKey,
    new Response(JSON.stringify(index), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=2592000",
        "x-file-size": String(head.size),
      },
    }),
  );
  return { file, index };
};

/** ファイルを開く (フッターだけを読む)。試験で手元のファイルを開くのに使う */
export const openTable = async (file: AsyncBuffer, keep?: Keep): Promise<Table> => ({
  file,
  index: indexOf(parquetMetadata(await readFooter(file)), keep),
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

/** 行グループ 1 つを読んで展開する。同じ問い合わせの中では覚えておく */
const readGroup = (table: Table, i: number): Promise<Record<string, unknown>[]> =>
  remember(table, String(i), () =>
    parquetReadObjects({
      file: table.file,
      metadata: metadataOf(table.index, table.index.groups[i]),
      columns: [...new Set(table.index.columns.map((c) => c.path[0]))],
      compressors,
    }),
  );

/** 表の行を全部読む (市区町村・都道府県のような小さな表) */
export const readAll = async <T>(table: Table): Promise<T[]> =>
  (await Promise.all(table.index.groups.map((_, i) => readGroup(table, i)))).flat() as T[];

/** 並べた列 key が value の行を読む。行グループごと読むので、ほかの値の行は読んだあとに落とす */
export const readWhere = async <T>(
  table: Table,
  key: string,
  value: string | number,
  onRows?: (rows: number) => void,
): Promise<T[]> => {
  if (table.index.sortKey !== key) throw new Error(`${key} で並べた表として開いていません`);
  const groups = groupsFor(table.index, value);
  onRows?.(groups.reduce((n, i) => n + table.index.groups[i][0], 0));
  return (await Promise.all(groups.map((i) => readGroup(table, i))))
    .flat()
    .filter((row) => (typeof value === "number" ? Number(row[key]) : row[key]) === value) as T[];
};

/** 市区町村 1 つ分の行を読む */
export const readCity = <T extends { lg_code: string }>(
  table: Table,
  lgCode: string,
  onRows?: (rows: number) => void,
): Promise<T[]> => readWhere<T>(table, "lg_code", lgCode, onRows);
