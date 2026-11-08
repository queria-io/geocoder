// どの表をどのファイルから読むかを決める。Worker が知るのは置き場 (DATA_SOURCE) だけにする。
//   - 「….json」: 目録。{ "version": "…", "tables": { "town": ["town.parquet"], … } }。
//     パスは目録からの相対。セルフホストで自分の Parquet を読ませるときはこれを置く
//   - 「…/」: FDL のリポジトリ。refs/heads/main が指すバージョンの files.json (表ごとのファイル一覧) から引く。
//     Sync で main が進めば、デプロイなしで読む先が切り替わる
import { retryOnce } from "./parquet";
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
 * sizes は FDL の files.json にあるファイルの大きさ (目録には無い)
 */
export type Resolved = {
  version: string;
  tables: Record<TableName, string[]>;
  sizes: Record<string, FileSize>;
};

type Manifest = { version: string; tables: Partial<Record<TableName, string[]>> };
/** FDL の versions/<ID>/files.json (カタログから作った表ごとのファイル一覧) */
export type FileList = {
  tables: Record<
    string,
    {
      renamed_columns?: boolean;
      files: {
        path?: string;
        url?: string;
        deletes?: unknown;
        bytes?: number;
        footer_bytes?: number;
      }[];
    }
  >;
};
type VersionRecord = { id: string; created_at: string };

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

export const fromVersion = (
  root: string,
  dataDir: string,
  v: VersionRecord,
  list: FileList,
): Resolved => ({
  // 前のバージョンの答えと同じ形 (geocoder-日付-ID の頭 8 桁) にそろえる
  version: `geocoder-${v.created_at.slice(0, 10).replaceAll("-", "")}-${v.id.slice(0, 8)}`,
  tables: fill((t) => {
    const table = list.tables[TABLES[t]];
    if (!table) return [];
    // 削除ファイルや列の改名は、Parquet だけを読むこの Worker では正しく読めない
    if (table.renamed_columns || table.files.some((f) => f.deletes))
      throw new Error(`${TABLES[t]} has deletes or renamed columns`);
    return table.files.map((f) => {
      if (!f.path) throw new Error(`${TABLES[t]} has a file outside the repository`);
      return root + dataDir + f.path;
    });
  }),
  sizes: Object.fromEntries(
    Object.values(list.tables).flatMap(({ files }) =>
      files.flatMap((f) =>
        f.path !== undefined && f.bytes !== undefined && f.footer_bytes !== undefined
          ? [[root + dataDir + f.path, { bytes: f.bytes, footer: f.footer_bytes }]]
          : [],
      ),
    ),
  ),
});

const resolve = async (bucket: R2Bucket, source: string, pin: string): Promise<Resolved> => {
  if (source.endsWith(".json"))
    return fromManifest(source, JSON.parse(await getText(bucket, source)) as Manifest);
  const config = JSON.parse(await getText(bucket, source + "fdl.json")) as { data_dir?: string };
  // pin があればそのバージョンに固定する (新しいバージョンに問題があったときの逃げ道)
  const id = pin || (await getText(bucket, source + "refs/heads/main")).trim();
  const dir = `${source}versions/${id}/`;
  const [record, list] = await Promise.all([
    getText(bucket, dir + "version.json"),
    // files.json の無いバージョン (fdl-cli 0.16 より前) は読めない
    getText(bucket, dir + "files.json"),
  ]);
  return fromVersion(
    source,
    config.data_dir ?? "data/",
    JSON.parse(record) as VersionRecord,
    JSON.parse(list) as FileList,
  );
};

/** 読む先を覚えておく時間。Sync のあと、遅くともこれだけたてば新しいバージョンを読む */
const TTL_MS = 5 * 60 * 1000;
let cached: { source: string; at: number; value: Promise<Resolved> } | null = null;

export const resetResolved = () => (cached = null);

export const resolveTables = (
  bucket: R2Bucket,
  source: string,
  pin = "",
  now = Date.now(),
): Promise<Resolved> => {
  const key = source + "@" + pin;
  if (cached?.source === key && now - cached.at < TTL_MS) return cached.value;
  const value = resolve(bucket, source, pin);
  // 読めなかったら前の読む先を使い続ける (refs を読めない一時の失敗で止めない)
  const previous = cached?.source === key ? cached.value : null;
  const guarded = previous ? value.catch(() => previous) : value;
  cached = { source: key, at: now, value: guarded };
  guarded.catch(() => (cached = null));
  return guarded;
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
