// 正引きの物差し。truth-forward.py の実住所を API に流し、当たった段・市区町村の一致・座標の誤差を出す。
// 使い方: pnpm tsx bench/forward-eval.ts bench/truth-forward.csv [出力の JSONL]
//   BASE=http://localhost:8787 で手元の wrangler dev にも流せる (既定は本番)
//   PREV=前回の出力の JSONL を渡すと、全体の数字を前回と並べる
//   BATCH=1 回に送る件数 (既定 25)、LANES=同時に送る本数 (既定 1)
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { chunks, parseCsv } from "./csv";
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
// 既定は /v1/forward/batch の上限 (src/index.ts の BATCH_MAX)。小さく割って並べると、1 回の CPU が上限に当たりにくく速い
const BATCH = Number(process.env.BATCH ?? 25);
const LANES = Number(process.env.LANES ?? 1);

// 住所に「,」「"」や改行が入るので、一括変換のページと同じ読み方で割る
const truths: Truth[] = parseCsv(readFileSync(process.argv[2], "utf8"))
  .slice(1)
  .map(([source, id, address, lat, lng, city]) => ({
    source,
    id,
    address,
    lat: Number(lat),
    lng: Number(lng),
    city,
  }));

const wait = (status: number | string, ms: number) => {
  process.stderr.write(`${status}: ${ms / 1000} 秒待って送り直す\n`);
  return new Promise((r) => setTimeout(r, ms));
};

const post = async (addresses: string[], tries = 3): Promise<Answer[]> => {
  // 答えが返らないまま止まる問い合わせもあるので、本文を読み終えるまでを 60 秒で切って送り直す
  // 名前を変える前の版 (/v1/batch) とも比較できるよう、404 なら以前の名前で送り直す
  const send = (path: string) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses }),
      signal: AbortSignal.timeout(60_000),
    });
  const res = await send("/v1/forward/batch")
    .then((r) => (r.status === 404 ? send("/v1/batch") : r))
    .then(async (r) => ({ status: r.status, ok: r.ok, body: await r.text() }))
    .catch((e: Error) => e);
  if (res instanceof Error) {
    if (tries === 0) throw res;
    await wait(res.name, 5_000);
    return post(addresses, tries - 1);
  }
  // 回数の上限 (429) と、R2 の一時的な失敗や CPU の超過 (5xx) は待って送り直す。何千件も流すので、1 回の失敗で全部を捨てない
  if ((res.status === 429 || res.status >= 500) && tries > 0) {
    await wait(res.status, res.status === 429 ? 60_000 : 5_000);
    return post(addresses, res.status === 429 ? tries : tries - 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.body}`);
  // 今の形は住所ごとに { address, results }。以前の版は住所ごとに 1 件か null
  type Item = { address: string; results: Answer[] } | Answer | null;
  return (JSON.parse(res.body) as { results: Item[] }).results.map((x) =>
    x !== null && "address" in x && Array.isArray(x.results)
      ? (x.results[0] ?? null)
      : (x as Answer),
  );
};

// LANES 本の列で、まとまりを順に取って送る。答えは元の順に戻す
const batches = chunks(truths, BATCH);
const done: Answer[][] = [];
const lane = async (next: { i: number }): Promise<void> => {
  const i = next.i++;
  if (i >= batches.length) return;
  done[i] = await post(batches[i].map((t) => t.address));
  return lane(next);
};
const cursor = { i: 0 };
await Promise.all(Array.from({ length: LANES }, () => lane(cursor)));
const answers: Answer[] = done.flat();

// 政令市の区は区のコードで返すが、指定避難所は市のコードで持つ (横浜市の区は 14101〜、避難所は 14100)。
// 区のコードを市のコードに戻してからも比べる
const DESIGNATED = [
  "01100",
  "04100",
  "11100",
  "12100",
  "14100",
  "14130",
  "14150",
  "15100",
  "22100",
  "22130",
  "23100",
  "26100",
  "27100",
  "27140",
  "28100",
  "33100",
  "34100",
  "40100",
  "40130",
  "43100",
];
const parentCity = (code: string): string | undefined => {
  const p = DESIGNATED.findLast((d) => d <= code);
  return p !== undefined && p !== code && p.slice(0, 3) === code.slice(0, 3) ? p : undefined;
};
const sameCityOf = (r: Row): boolean => {
  const code = r.answer?.lg_code?.slice(0, 5);
  return code !== undefined && (code === r.city || parentCity(code) === r.city);
};

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
  const sameCity = rs.filter(sameCityOf).length;
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

const prev = process.env.PREV;
if (prev && existsSync(prev)) {
  const before = readFileSync(prev, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Row);
  console.log("## 前回と今回\n");
  console.log(
    table([
      ["前回", before],
      ["今回", rows],
    ]),
  );
  console.log("");
}
console.log(`## 元データごと (${BASE})\n`);
console.log(table([...groupBy(rows, (r) => r.source), ["全体", rows]]));
console.log("\n## 当たった段ごと\n");
console.log(table(groupBy(rows, (r) => r.answer?.match_level ?? "答えなし")));
console.log("\n## 座標の点の段ごと\n");
console.log(table(groupBy(rows, (r) => r.answer?.coordinates_level ?? "座標なし")));
