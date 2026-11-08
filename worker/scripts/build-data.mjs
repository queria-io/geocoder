// ジオコーダーが読む表を public/data/ に置き、Worker の静的アセットとして一緒にデプロイする。
// 静的アセットは Cloudflare の各拠点に配られるので、R2 より速く読める (1 回 10 ミリ秒前後)。
// FDL のリポジトリ (既定は data.queria.io/geocoder) の refs/heads/main が指すバージョンを取る。
// 使い方: node scripts/build-data.mjs [リポジトリの URL]
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const repo = (
  process.argv[2] ??
  process.env.GEOCODER_DATA_URL ??
  "https://data.queria.io/geocoder/"
).replace(/\/?$/, "/");
const out = new URL("../public/", import.meta.url);
// 静的アセットの 1 ファイルの上限
const MAX_BYTES = 25 * 1024 * 1024;

const tables = JSON.parse(
  await readFile(new URL("../src/data/tables.json", import.meta.url), "utf8"),
);

const get = async (path) => {
  for (let i = 0; ; i++) {
    const r = await fetch(repo + path);
    if (r.ok) return r;
    if (i >= 2) throw new Error(`${r.status} ${repo + path}`);
  }
};

const { data_dir: dataDir = "data/" } = await (await get("fdl.json")).json();
const id = (await (await get("refs/heads/main")).text()).trim();
const record = await (await get(`versions/${id}/version.json`)).json();
const list = await (await get(`versions/${id}/files.json`)).json();

const files = Object.entries(tables).map(([name, fdl]) => {
  const table = list.tables[fdl];
  if (!table) return [name, []];
  if (table.renamed_columns || table.files.some((f) => f.deletes))
    throw new Error(`${fdl} has deletes or renamed columns`);
  return [name, table.files];
});

const keyOf = (f) => `data/${dataDir}${f.path}`;
const all = files.flatMap(([, fs]) => fs);
const big = all.filter((f) => f.bytes > MAX_BYTES);
if (big.length > 0) {
  // 静的アセットに載らないバージョン (市区町村ごとに分ける前のデータ) では何も置かない。Worker は R2 から読む
  await rm(new URL("data/", out), { recursive: true, force: true });
  console.log(`静的アセットに置かない (25 MiB を超えるファイルが ${big.length} 個)`);
  process.exit(0);
}

// 同じものが既にあれば取り直さない
const fetchOne = async (f) => {
  const dest = new URL(keyOf(f), out);
  const have = await stat(dest).catch(() => null);
  if (have?.size === f.bytes) return;
  const body = Buffer.from(await (await get(dataDir + f.path)).arrayBuffer());
  if (body.length !== f.bytes) throw new Error(`size mismatch: ${f.path}`);
  await mkdir(dirname(dest.pathname), { recursive: true });
  await writeFile(dest, body);
};
const queue = [...all];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) await fetchOne(f);
  }),
);

// Worker が読む目録 (src/data/source.ts の Resolved と同じ形)
const manifest = {
  version: `geocoder-${record.created_at.slice(0, 10).replaceAll("-", "")}-${record.id.slice(0, 8)}`,
  tables: Object.fromEntries(files.map(([name, fs]) => [name, fs.map(keyOf)])),
  sizes: Object.fromEntries(all.map((f) => [keyOf(f), { bytes: f.bytes, footer: f.footer_bytes }])),
};
await writeFile(new URL("data/geocoder.json", out), JSON.stringify(manifest));
const total = all.reduce((n, f) => n + f.bytes, 0);
console.log(`${manifest.version}: ${all.length} files, ${(total / 2 ** 20).toFixed(0)} MiB`);
