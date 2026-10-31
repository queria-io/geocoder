// 本番の境界タイルで逆引きを流し、truth.py の正解と比べる。速さはタイル取得と判定を分けて測る。
// 使い方: pnpm tsx bench/run.ts bench/points.csv
import { readFileSync } from "node:fs";

import { FetchSource, PMTiles } from "pmtiles";

import { resolveAreas, type TilePoint } from "../src/lookup";

const URL = "https://assets.queria.io/boundaries/boundaries-20261027.pmtiles";
const archive = new PMTiles(new FetchSource(URL));

const rows = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [code, lng, lat, border] = line.split(",");
    return { code, lng: Number(lng), lat: Number(lat), border: Number(border) };
  });

const fetchMs: number[] = [];
const tileBytes: number[] = [];
const tiles = new Map<string, ArrayBuffer | null>();
const readTile = async ({ z, x, y }: TilePoint) => {
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    const t0 = performance.now();
    const data = (await archive.getZxy(z, x, y))?.data ?? null;
    fetchMs.push(performance.now() - t0);
    tileBytes.push(data?.byteLength ?? 0);
    tiles.set(key, data);
  }
  return tiles.get(key) ?? null;
};

const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const buckets = [
  ["< 0.5m", 0, 0.5],
  ["0.5-1m", 0.5, 1],
  ["1-2m", 1, 2],
  ["2-5m", 2, 5],
  ["5-20m", 5, 20],
  ["20-50m", 20, 50],
  ["50-200m", 50, 200],
  [">= 200m", 200, Infinity],
] as const;

// タイルを先に取っておく
for (const row of rows) await resolveAreas(row.lng, row.lat, readTile);
// 2 周目はタイルが手元にあるので、判定 (デコード + 多角形の内外) だけの時間になる
const cpuMs: number[] = [];
const results = [];
for (const row of rows) {
  const t0 = performance.now();
  const got = await resolveAreas(row.lng, row.lat, readTile);
  cpuMs.push(performance.now() - t0);
  results.push({ ...row, got });
}

const report = buckets.map(([label, lo, hi]) => {
  const xs = results.filter((r) => r.border >= lo && r.border < hi);
  const ok = xs.filter((r) => r.got.estat_small_area_code === r.code).length;
  const city = xs.filter((r) => r.got.city_code === r.code.slice(0, 5)).length;
  return { label, n: xs.length, small_area: `${ok}/${xs.length}`, city: `${city}/${xs.length}` };
});
const all = results.filter((r) => r.got.estat_small_area_code === r.code).length;
console.log(
  `点 ${results.length}、町丁目一致 ${all} (${((all / results.length) * 100).toFixed(2)}%)`,
);
console.log(
  `町丁目に入らず null: ${results.filter((r) => r.got.estat_small_area_code === null).length}`,
);
console.table(report);
console.log(
  `タイル取得 ${fetchMs.length} 回: 中央 ${pct(fetchMs, 0.5).toFixed(0)}ms / 95% ${pct(fetchMs, 0.95).toFixed(0)}ms、` +
    `大きさ 中央 ${(pct(tileBytes, 0.5) / 1024).toFixed(0)}KB / 最大 ${(Math.max(...tileBytes) / 1024).toFixed(0)}KB`,
);
console.log(
  `判定 (タイル手元): 中央 ${pct(cpuMs, 0.5).toFixed(2)}ms / 95% ${pct(cpuMs, 0.95).toFixed(2)}ms / 最大 ${Math.max(...cpuMs).toFixed(2)}ms`,
);
const misses = results.filter((r) => r.got.estat_small_area_code !== r.code).slice(0, 15);
console.table(
  misses.map((r) => ({
    code: r.code,
    got: r.got.estat_small_area_code,
    lng: r.lng,
    lat: r.lat,
    border_m: r.border,
  })),
);
