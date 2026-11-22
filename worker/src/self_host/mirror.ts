// 公開のデータ (data.queria.io の geocoder と、境界タイル) を自分の R2 に取り込む。セルフホストで
// Queria に依存したくないときに Cron Trigger から呼ぶ。FDL のリポジトリの置き方 (fdl.json・refs/heads/main・
// versions/<ID>/・データのファイル) をそのまま写し、refs/heads/main は最後に書き換える。
// ファイルのパスはバージョンごとに変わらないので、既にあるものは写さない
import { fromVersion, tablesFile, type TableList, type VersionRecord } from "../data/source";

const textOf = async (bucket: R2Bucket, key: string): Promise<string | null> =>
  (await (await bucket.get(key))?.text()) ?? null;

const mustText = async (bucket: R2Bucket, key: string): Promise<string> => {
  const t = await textOf(bucket, key);
  if (t === null) throw new Error(`not found: ${key}`);
  return t;
};

/** 1 つのファイルを写す。大きいファイル (地番は 400MB を超える) も、メモリに載せずに流す */
const copy = async (from: R2Bucket, to: R2Bucket, key: string): Promise<boolean> => {
  if (await to.head(key)) return false;
  const src = await from.get(key);
  if (!src || !("body" in src)) throw new Error(`not found: ${key}`);
  const { readable, writable } = new FixedLengthStream(src.size);
  await Promise.all([src.body.pipeTo(writable), to.put(key, readable)]);
  return true;
};

/**
 * そのバージョンが読むデータのファイル (ジオコーダーが使う表だけ)。Worker と同じ fromVersion で引くので、
 * Worker が読めないバージョン (削除ファイル・列の改名・外のファイル) はここで止まり、refs/heads/main を進めない
 */
const dataFiles = (source: string, dataDir: string, id: string, list: TableList): string[] =>
  Object.values(fromVersion(source, dataDir, { id, created_at: "" }, list).tables).flat();

/** そのバージョンの tables.json。version.json が指すファイル名で読む */
const tableList = async (bucket: R2Bucket, dir: string): Promise<TableList> => {
  const record = JSON.parse(await mustText(bucket, dir + "version.json")) as VersionRecord;
  return JSON.parse(await mustText(bucket, dir + tablesFile(record))) as TableList;
};

const listAll = async (bucket: R2Bucket, prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
};

export type MirrorResult = { version: string; copied: number; deleted: number };

export const mirror = async (
  origin: R2Bucket,
  store: R2Bucket,
  source: string,
  extra: { origin: R2Bucket; key: string }[] = [],
): Promise<MirrorResult> => {
  for (const x of extra) await copy(x.origin, store, x.key);
  const ref = source + "refs/heads/main";
  const latest = (await mustText(origin, ref)).trim();
  const current = (await textOf(store, ref))?.trim() ?? null;
  if (latest === current) return { version: latest, copied: 0, deleted: 0 };

  const config = await mustText(origin, source + "fdl.json");
  const dataDir = (JSON.parse(config) as { data_dir?: string }).data_dir ?? "tables/";
  const dir = `${source}versions/${latest}/`;
  await copy(origin, store, dir + "version.json");
  const record = JSON.parse(await mustText(store, dir + "version.json")) as VersionRecord;
  await copy(origin, store, dir + tablesFile(record));
  const files = dataFiles(source, dataDir, latest, await tableList(store, dir));
  let copied = 0;
  for (const key of files) if (await copy(origin, store, key)) copied++;
  // fdl.json はバージョンごとのファイルでないので、あっても読んだ中身で書き直す (data_dir が変わったときのため)
  await store.put(source + "fdl.json", config);
  await store.put(ref, latest + "\n");

  // 今と 1 つ前のバージョンが読むファイルだけを残す (切り替えの直後に前のバージョンを読む Worker があるため)
  const keep = new Set(files);
  if (current) {
    const previous = await tableList(store, `${source}versions/${current}/`).catch(() => null);
    if (previous) for (const k of dataFiles(source, dataDir, current, previous)) keep.add(k);
  }
  const stale = (await listAll(store, source + dataDir)).filter((k) => !keep.has(k));
  for (let i = 0; i < stale.length; i += 1000) await store.delete(stale.slice(i, i + 1000));
  return { version: latest, copied, deleted: stale.length };
};
