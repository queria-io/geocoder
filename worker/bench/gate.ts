// マージ前の精度チェック。同じ住所を本番 (基準) と PR のプレビューに送った 2 つの JSONL を比較し、
// 悪くなっていれば 1 で終わる。表と、遠ざかった住所の一覧を Markdown で出す
// 使い方: pnpm tsx bench/gate.ts 基準.jsonl PR.jsonl
import { readFileSync } from "node:fs";

type Row = {
  source: string;
  /** 住所の書き方の型 (truth-forward.py の PATTERNS) */
  pattern?: string;
  address: string;
  answer: { match_level: string; coordinates_level: string | null } | null;
  error_m: number | null;
};

const read = (path: string): Row[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Row);

const [base, head] = [read(process.argv[2]), read(process.argv[3])];
if (base.length !== head.length) throw new Error(`件数が違う: ${base.length} と ${head.length}`);

// 番地より細かい点 (住居表示の街区・号、地番、親番)
const FINE = new Set(["rsdtdsp_blk", "rsdtdsp_rsdt", "parcel", "parcel_parent"]);
const FAR = 500;

type Stats = { answered: number; located: number; fine: number; median: number; over1km: number };
const stats = (rs: Row[]): Stats => {
  const errors = rs.flatMap((r) => (r.error_m === null ? [] : [r.error_m])).sort((a, b) => a - b);
  const share = (n: number, d: number) => (d === 0 ? 0 : (100 * n) / d);
  return {
    answered: share(rs.filter((r) => r.answer !== null).length, rs.length),
    located: share(errors.length, rs.length),
    fine: share(rs.filter((r) => FINE.has(r.answer?.coordinates_level ?? "")).length, rs.length),
    median: errors[Math.floor((errors.length - 1) / 2)] ?? 0,
    over1km: share(errors.filter((e) => e > 1000).length, errors.length),
  };
};

// 座標を失ったものは、遠ざかったものとして数える
const moved = base.map((b, i) => ({ b, h: head[i] }));
const worse = moved.filter(
  ({ b, h }) => b.error_m !== null && (h.error_m === null || h.error_m - b.error_m >= FAR),
);
const better = moved.filter(
  ({ b, h }) => h.error_m !== null && (b.error_m === null || b.error_m - h.error_m >= FAR),
);

const [s0, s1] = [stats(base), stats(head)];
// 止める条件。数パーセントの揺れは R2 の読みの失敗などでも出るので、わずかな幅は見逃す
const failures = [
  s1.answered < s0.answered - 0.1 && "回答率が下がった",
  s1.located < s0.located - 0.1 && "座標付与率が下がった",
  s1.fine < s0.fine - 0.2 && "地番・街区レベル以上の割合が下がった",
  s1.median > s0.median + 2 && "誤差の中央値が 2m を超えて悪くなった",
  s1.over1km > s0.over1km + 0.2 && "1km 超が増えた",
  worse.length > better.length && `${FAR}m 以上遠ざかった住所が、近づいた住所より多い`,
].filter((f): f is string => f !== false);

// 誤照合: 座標を返したが、正解から 1km を超えて離れているもの。間違った場所を返すと利用者は気づけないので、
// 書き方の型ごとに 1 件でも増えたら失敗にする (「字」を読み飛ばして別の町字に当てるなど)
const MISS = 1000;
const isMiss = (r: Row) => r.error_m !== null && r.error_m > MISS;
const patterns = [...new Set(base.map((r) => r.pattern ?? "-"))].sort();
const misses = patterns.map((p) => {
  const ids = base.flatMap((r, i) => ((r.pattern ?? "-") === p ? [i] : []));
  return {
    pattern: p,
    count: ids.length,
    base: ids.filter((i) => isMiss(base[i])).length,
    head: ids.filter((i) => isMiss(head[i])).length,
  };
});
failures.push(
  ...misses
    .filter((m) => m.head > m.base)
    .map(
      (m) =>
        `書き方の型「${m.pattern}」で誤照合 (${MISS / 1000}km 超) が ${m.base} 件から ${m.head} 件に増えた`,
    ),
);

const pct = (x: number) => `${x.toFixed(1)}%`;
const line = (label: string, s: Stats) =>
  `| ${label} | ${pct(s.answered)} | ${pct(s.located)} | ${pct(s.fine)} | ${Math.round(s.median)} | ${pct(s.over1km)} |`;
const km = (x: number | null) => (x === null ? "なし" : `${Math.round(x)}m`);

console.log(
  [
    `## 精度チェック: ${failures.length === 0 ? "合格" : "不合格"}`,
    "",
    ...failures.map((f) => `- ${f}`),
    "",
    "| | 回答率 | 座標付与率 | 地番・街区レベル以上 | 誤差の中央値 (m) | 1km 超 |",
    "|---|---|---|---|---|---|",
    line("本番", s0),
    line("この PR", s1),
    "",
    "書き方の型ごとの誤照合 (座標を返したが正解から 1km 超)",
    "",
    "| 型 | 件数 | 本番 | この PR |",
    "|---|---|---|---|",
    ...misses.map((m) => `| ${m.pattern} | ${m.count} | ${m.base} | ${m.head} |`),
    "",
    `${FAR}m 以上 近づいた ${better.length} 件、遠ざかった ${worse.length} 件 (座標を失ったものを含む)`,
    "",
    ...(worse.length === 0
      ? []
      : [
          "| 住所 | 本番 | この PR |",
          "|---|---|---|",
          ...worse
            .slice(0, 50)
            .map(
              ({ b, h }) =>
                `| ${b.address} | ${km(b.error_m)} (${b.answer?.coordinates_level ?? "-"}) | ${km(h.error_m)} (${h.answer?.coordinates_level ?? "-"}) |`,
            ),
        ]),
  ].join("\n"),
);
process.exitCode = failures.length === 0 ? 0 : 1;
