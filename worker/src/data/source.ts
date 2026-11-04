// どの表をどのファイルから読むかを決める。Worker が知るのは置き場 (DATA_SOURCE) だけにする。
//   - 「….json」: 目録。{ "version": "…", "tables": { "town": ["town.parquet"], … } }。
//     パスは目録からの相対。セルフホストで自分の Parquet を読ませるときはこれを置く
//   - 「…/」: FDL のリポジトリ。refs/heads/main が指すバージョンの files.json (表ごとのファイル一覧) から引く。
//     Sync で main が進めば、デプロイなしで読む先が切り替わる
import { retryOnce } from "./parquet";

/** ジオコーダーが読む表。FDL では右の名前 (スキーマ.表) で引く */
export const TABLES = {
  town: "town.town",
  city: "main.city",
  pref: "main.pref",
  rsdtdsp: "main.rsdtdsp",
  parcel: "main.parcel",
  point: "main.address_point",
  town_name: "town.town_name",
} as const;
export type TableName = keyof typeof TABLES;

/** 表ごとの R2 キー (読む順)。空の配列は「その段は流さない」 */
export type Resolved = { version: string; tables: Record<TableName, string[]> };

type Manifest = { version: string; tables: Partial<Record<TableName, string[]>> };
/** FDL の versions/<ID>/files.json (カタログから作った表ごとのファイル一覧) */
export type FileList = {
  tables: Record<
    string,
    { renamed_columns?: boolean; files: { path?: string; url?: string; deletes?: unknown }[] }
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
