// どの表をどのファイルから読むかを決める。Worker が知るのは置き場 (DATA_SOURCE) だけにする。
//   - 「….json」: 目録。{ "version": "…", "tables": { "town": ["town.parquet"], … } }。
//     パスは目録からの相対。セルフホストで自分の Parquet を読ませるときはこれを置く
//   - 「…/」: FDL のデータセット。refs/heads/main が指すバージョンの tables.json (表ごとのファイル一覧) を fdl-js で引く。
//     Sync で main が進めば、デプロイなしで読む先が切り替わる
import {
  open,
  r2Store,
  refreshing,
  retryOnce,
  tableFiles,
  type DataFile,
  type Version,
} from "@queria-io/fdl-js";

import tables from "./tables.json";

/** ジオコーダーが読む表。FDL では右の名前 (スキーマ.表) で引く。scripts/build-data.mjs も同じ一覧を読む */
export const TABLES = tables as Readonly<Record<keyof typeof tables, string>>;
export type TableName = keyof typeof TABLES;

/** ファイルを分ける列。パスの「列=値/」のうち、この列だけを読むファイルの選択に使う */
const PARTITION_COLUMNS = ["pref_code", "lg_code", "name_bucket"] as const;
const PARTITION_SEGMENT = new RegExp(`(?:^|/)(${PARTITION_COLUMNS.join("|")})=([^/]+)/`, "g");

/** 分けたファイルのパスにある「列=値/」。読むファイルを列の値で選ぶ */
export type Partition = Partial<Record<(typeof PARTITION_COLUMNS)[number], string>>;

/**
 * 表のファイルのうち、want の値の行が入るもの。分けた表のファイルはパスに「pref_code=13/」「lg_code=131016/」
 * 「name_bucket=41/」を持つ。パスの列がすべて want と同じ値のファイルを返す。分けていない表のファイルは全部返す。
 * ほかの「列=値/」(置き場のパスや、Worker の知らない列) では選ばない (読む量は増えても、行を落とさない)
 */
export const filesFor = (keys: readonly string[], want: Partition): string[] =>
  keys.filter((k) =>
    [...k.matchAll(PARTITION_SEGMENT)].every(
      ([, col, value]) => want[col as keyof Partition] === value,
    ),
  );

/** 町名の索引のファイルの区分。dbt の town_name と同じ式 (名前の 1 文字目の文字コードを 64 で割った余り) */
export const nameBucket = (nameKey: string): string => String((nameKey.codePointAt(0) ?? 0) % 64);

/** ファイルの大きさとフッター (メタデータ) の長さ。分かればフッターを 1 回の読みで取れる */
export type FileSize = { bytes: number; footer: number };

/**
 * 表ごとの R2 キー (読む順)。空の配列は「その段は流さない」。
 * sizes は FDL の tables.json にあるファイルの大きさ (目録には無い)
 */
export type Resolved = {
  version: string;
  tables: Record<TableName, string[]>;
  sizes: Record<string, FileSize>;
};

type Manifest = { version: string; tables: Partial<Record<TableName, string[]>> };

const dirOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);

const getText = async (bucket: R2Bucket, key: string): Promise<string> => {
  const o = await retryOnce(() => bucket.get(key));
  if (!o) throw new Error(`not found: ${key}`);
  return o.text();
};

const fill = (pick: (t: TableName) => string[]): Record<TableName, string[]> =>
  Object.fromEntries((Object.keys(TABLES) as TableName[]).map((t) => [t, pick(t)])) as Record<
    TableName,
    string[]
  >;

export const fromManifest = (key: string, m: Manifest): Resolved => ({
  version: m.version,
  tables: fill((t) => (m.tables[t] ?? []).map((p) => dirOf(key) + p)),
  sizes: {},
});

/**
 * 表のデータファイル。削除ファイルや列の改名がある表は、Parquet だけを読むこの Worker では正しく読めないので止める
 */
const dataFiles = (v: Version, t: TableName): DataFile[] => {
  const files = tableFiles(v, TABLES[t]) ?? [];
  if (v.files.tables[TABLES[t]]?.renamed_columns || files.some((f) => f.deletes))
    throw new Error(`${TABLES[t]} has deletes or renamed columns`);
  return files;
};

/** FDL のバージョンの tables.json から、表ごとの R2 キーを引く。root はデータセットの置き場 (R2 のキーの頭) */
export const fromVersion = (root: string, v: Version): Resolved => {
  const files = (Object.keys(TABLES) as TableName[]).map((t) => [t, dataFiles(v, t)] as const);
  return {
    // 前のバージョンの答えと同じ形 (geocoder-日付-ID の頭 8 桁) にそろえる
    version: `geocoder-${v.record.created_at.slice(0, 10).replaceAll("-", "")}-${v.record.id.slice(0, 8)}`,
    tables: Object.fromEntries(files.map(([t, fs]) => [t, fs.map((f) => root + f.key)])) as Record<
      TableName,
      string[]
    >,
    sizes: Object.fromEntries(
      files.flatMap(([, fs]) =>
        fs.flatMap((f) =>
          f.footerBytes !== undefined
            ? [[root + f.key, { bytes: f.bytes, footer: f.footerBytes }]]
            : [],
        ),
      ),
    ),
  };
};

const resolve = async (bucket: R2Bucket, source: string, pin: string): Promise<Resolved> => {
  if (source.endsWith(".json"))
    return fromManifest(source, JSON.parse(await getText(bucket, source)) as Manifest);
  // pin があればそのバージョンに固定する (新しいバージョンに問題があったときの逃げ道)
  return fromVersion(source, await open(r2Store(bucket, source), pin || "refs/heads/main"));
};

/** 読む先を覚えておく時間。Sync のあと、遅くともこれだけたてば新しいバージョンを読む */
const TTL_MS = 5 * 60 * 1000;
const loaders = new Map<string, () => Promise<Resolved>>();

/** 読む先。TTL_MS のあいだ覚え、読み直しに失敗したら前の読む先を使い続ける (refs を読めない一時の失敗で止めない) */
export const resolveTables = (bucket: R2Bucket, source: string, pin = ""): Promise<Resolved> => {
  const key = source + "@" + pin;
  let loader = loaders.get(key);
  if (!loader) {
    loader = refreshing(() => resolve(bucket, source, pin), TTL_MS, { onError: console.error });
    loaders.set(key, loader);
  }
  return loader();
};

/** Worker と一緒に置いたデータの目録 (pnpm build:data が public/data/ に書く)。キーは静的アセットのパス */
export const ASSETS_MANIFEST = "data/geocoder.json";

let assetsResolved: Promise<Resolved | null> | null = null;

/**
 * 静的アセットに置いたデータを読む先。データはデプロイと一緒に変わるので、isolate の中で 1 回だけ読む。
 * 置いていなければ null (R2 から読む)
 */
export const resolveAssets = (assets: Fetcher): Promise<Resolved | null> => {
  assetsResolved ??= assets
    .fetch(new Request(`https://assets.local/${ASSETS_MANIFEST}`))
    .then(async (r) => (r.ok ? ((await r.json()) as Resolved) : null));
  assetsResolved.catch(() => (assetsResolved = null));
  return assetsResolved;
};
