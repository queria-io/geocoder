// ジオコーダーが読む表を public/data/ に置き、Worker の静的アセットとして一緒にデプロイする。
// 静的アセットは Cloudflare の各拠点に配られるので、R2 より速く読める (1 回 10 ミリ秒前後)。
// FDL のリポジトリ (既定は data.queria.io/geocoder) の refs/heads/main が指すバージョンを取る。
// 使い方: node scripts/build-data.mjs [リポジトリの URL]
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { httpStore, open, tableFiles } from "@queria-io/fdl-js";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * path を取り、read で読む。エラーの応答も、接続や本文の読みの失敗も、間をあけて 3 回まで試す
 * (数千のファイルを取るので、1 回の失敗でビルドを止めない)
 */
const get = async (path, read) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(repo + path);
      if (!r.ok) throw new Error(`${r.status} ${repo + path}`);
      return await read(r);
    } catch (e) {
      if (i >= 2) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
};

/** fdl-js の読み (fdl.json・refs・version.json・tables.json) も、get と同じく間をあけて 3 回まで試す */
const retryingFetch = async (url, init) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status < 500 || i >= 2) return r;
    } catch (e) {
      if (i >= 2) throw e;
    }
    await sleep(1000 * 2 ** i);
  }
};

// refs/heads/main が指すバージョンの tables.json を読む
const version = await open(httpStore(repo, { fetch: retryingFetch }), "refs/heads/main");
const { record } = version;

const files = Object.entries(tables).map(([name, fdl]) => {
  const table = tableFiles(version, fdl) ?? [];
  if (version.files.tables[fdl]?.renamed_columns || table.some((f) => f.deletes))
    throw new Error(`${fdl} has deletes or renamed columns`);
  // Worker はフッターの長さが分かっている前提で開く (src/data/parquet.ts の openFile)
  if (table.some((f) => f.footerBytes === undefined))
    throw new Error(`${fdl} has a file without footer_bytes`);
  return [name, table];
});

// f.key はデータセットの置き場からのパス (data_dir を含む)
const keyOf = (f) => `data/${f.key}`;
const all = files.flatMap(([, fs]) => fs);
const big = all.filter((f) => f.bytes > MAX_BYTES);
if (big.length > 0) {
  // 静的アセットに載らないバージョン (市区町村ごとに分ける前のデータ) では何も置かない。Worker は R2 から読む
  await rm(new URL("data/", out), { recursive: true, force: true });
  console.log(`静的アセットに置かない (25 MiB を超えるファイルが ${big.length} 個)`);
  process.exit(0);
}

// 前のビルドの目録と、今のバージョンに無いファイルを消す。取る途中で止まっても、古い目録が
// 消えたファイルを指さないようにし、前のバージョンのファイルを一緒にデプロイしない
const dataUrl = new URL("data/", out);
const manifestUrl = new URL("data/geocoder.json", out);
await rm(manifestUrl, { force: true });
const keep = new Set(all.map(keyOf));
const root = fileURLToPath(out);
const present = await readdir(dataUrl, { recursive: true, withFileTypes: true }).catch(() => []);
for (const d of present) {
  if (!d.isFile()) continue;
  const path = join(d.parentPath, d.name);
  if (!keep.has(relative(root, path).split(sep).join("/"))) await rm(path);
}

// 同じものが既にあれば取り直さない
const fetchOne = async (f) => {
  const dest = new URL(keyOf(f), out);
  const have = await stat(dest).catch(() => null);
  if (have?.size === f.bytes) return;
  const body = await get(f.key, async (r) => {
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length !== f.bytes) throw new Error(`size mismatch: ${f.key}`);
    return b;
  });
  await mkdir(dirname(fileURLToPath(dest)), { recursive: true });
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
  sizes: Object.fromEntries(all.map((f) => [keyOf(f), { bytes: f.bytes, footer: f.footerBytes }])),
};
await mkdir(dataUrl, { recursive: true });
await writeFile(manifestUrl, JSON.stringify(manifest));
const total = all.reduce((n, f) => n + f.bytes, 0);
console.log(`${manifest.version}: ${all.length} files, ${(total / 2 ** 20).toFixed(0)} MiB`);
