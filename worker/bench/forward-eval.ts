// 正引きの物差し。truth-forward.py の実住所を API に流し、当たった段・市区町村の一致・座標の誤差を出す。
// 使い方: pnpm tsx bench/forward-eval.ts bench/truth-forward.csv [出力の JSONL]
//   BASE=http://localhost:8787 で手元の wrangler dev にも流せる (既定は本番)
import { readFileSync, writeFileSync } from "node:fs";

import { distanceM } from "../src/nearby";

type Truth = {
  source: string;
  id: string;
  address: string;
  lat: number;
  lng: number;
  city: string;
};
type Answer = {
  lat: number | null;
  lng: number | null;
  match_level: string;
  coordinates_level: string | null;
  lg_code: string | null;
} | null;
type Row = Truth & { answer: Answer; error_m: number | null };

const BASE = process.env.BASE ?? "https://geocoder.queria.io";
const BATCH = 100;

// 住所に「,」や「"」が入るので、CSV は引用符を見て割る
const splitCsv = (line: string): string[] =>
  [...line.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)]
    .slice(0, -1)
    .map(([, v]) => (v.startsWith('"') ? v.slice(1, -1).replaceAll('""', '"') : v));

const truths: Truth[] = readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map(splitCsv)
  .map(([source, id, address, lat, lng, city]) => ({
    source,
    id,
    address,
    lat: Number(lat),
    lng: Number(lng),
    city,
  }));

const post = async (addresses: string[]): Promise<Answer[]> => {
  const res = await fetch(`${BASE}/v1/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ addresses }),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 60_000));
    return post(addresses);
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return ((await res.json()) as { results: Answer[] }).results;
};

const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const answers: Answer[] = [];
for (const c of chunks(truths, BATCH)) answers.push(...(await post(c.map((t) => t.address))));

const rows: Row[] = truths.map((t, i) => {
  const a = answers[i];
  const error_m = a?.lat == null || a.lng == null ? null : distanceM(t.lat, t.lng, a.lat, a.lng);
  return { ...t, answer: a, error_m };
});
if (process.argv[3]) writeFileSync(process.argv[3], rows.map((r) => JSON.stringify(r)).join("\n"));

const pct = (xs: number[], p: number): number | null =>
  xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
const share = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const fmt = (x: number | null) => (x === null ? "-" : String(Math.round(x)));

const summary = (label: string, rs: Row[]) => {
  const errors = rs.flatMap((r) => (r.error_m === null ? [] : [r.error_m]));
  const sameCity = rs.filter((r) => r.answer?.lg_code?.slice(0, 5) === r.city).length;
  return [
    label,
    rs.length,
    share(rs.filter((r) => r.answer !== null).length, rs.length),
    share(sameCity, rs.length),
    fmt(pct(errors, 0.5)),
    fmt(pct(errors, 0.9)),
    fmt(pct(errors, 0.95)),
    share(errors.filter((e) => e > 100).length, errors.length),
    share(errors.filter((e) => e > 1000).length, errors.length),
  ].join(" | ");
};

const groupBy = <K extends string>(rs: Row[], key: (r: Row) => K) =>
  [...Map.groupBy(rs, key)].sort(([a], [b]) => (a < b ? -1 : 1));

const header =
  "| 区分 | 件数 | 答えあり | 市区町村が一致 | 誤差の中央値 (m) | 90% | 95% | 100m 超 | 1km 超 |\n|---|---|---|---|---|---|---|---|---|";
const table = (groups: [string, Row[]][]) =>
  [header, ...groups.map(([k, rs]) => `| ${summary(k, rs)} |`)].join("\n");

console.log(`## 元データごと (${BASE})\n`);
console.log(table([...groupBy(rows, (r) => r.source), ["全体", rows]]));
console.log("\n## 当たった段ごと\n");
console.log(table(groupBy(rows, (r) => r.answer?.match_level ?? "答えなし")));
console.log("\n## 座標の点の段ごと\n");
console.log(table(groupBy(rows, (r) => r.answer?.coordinates_level ?? "座標なし")));
