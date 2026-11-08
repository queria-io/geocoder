// 照合の根拠 (include=evidence)。座標を取った点の出典と行の鍵、住所のどこをどの区域・番号に照合したか、
// 上流 (abr-geocoder) の照合の後に使った段を返す。段の名前は API の値なので、増やすときは STEPS と仕様書に足し、
// 名前は変えない
import type { MatchedResult } from "./model/model";
import type { Located } from "./locate/locate";

/** 上流の照合の後に使った段。並びは使った順 */
export const STEPS = {
  former_city: "旧市区町村名を今の市区町村名に読み替えた",
  renamed_ward: "浜松市の旧区名を今の区名に読み替えた",
  city_inferred:
    "市区町村名の無い住所で、町名から市区町村を推定した (同じ町名の市区町村が複数なら candidates が 2 以上)",
  ward_inferred: "政令市の市名を省いて区から書いた住所で、市名を補った",
  kyoto_street_skipped: "市区町村名の無い住所で、頭の京都の通り名を外して町名を引いた",
  oaza_omitted: "大字を省いた丁目の住所で、大字を補った",
  aza_skipped: "ABR に無い小字の名前を外して、大字と番号で照合した",
  number_tail: "番号の書き方 (「28街区28号」など) や番号の後ろの建物名を読み替えて照合した",
  partway: "住所の頭からは区域に照合できず、途中から区域を読んだ",
  text_skipped: "区域と番号の間の、索引に無い文字を読み飛ばした (skipped)",
  prefix_dropped: "番号の頭の甲乙丙丁を外した番号の点を使った",
  prefix_added:
    "甲乙丙丁が書かれていない番号に、甲乙丙丁を付けた番号の点を使った (候補が複数なら candidates が 2 以上)",
} as const;
export type Step = keyof typeof STEPS;

/** 座標を取った点の出典と、その行の鍵 */
export type EvidencePoint = {
  /** Queria のデータセット。address_br はアドレス・ベース・レジストリ、nlftp は国土数値情報・位置参照情報 */
  dataset: "address_br" | "nlftp" | null;
  /** 点の種類 */
  point_type:
    | "rsdt"
    | "block"
    | "parcel"
    | "parcel_parent"
    | "history"
    | "machiaza"
    | "machiaza_derived"
    | "city";
  /** 同じ住所に点が複数あるときの優先順位 (小さいほど先)。町字・市区町村の代表点は null */
  rank: number | null;
  keys: {
    lg_code: string | null;
    machiaza_id: string | null;
    blk_id: string | null;
    rsdt_id: string | null;
    rsdt2_id: string | null;
    prc_id: string | null;
    /** 照合した番号 (「3-1」) */
    number: string | null;
  };
};

/** 点の行の鍵がすべて null の形 */
export const NO_KEYS: EvidencePoint["keys"] = {
  lg_code: null,
  machiaza_id: null,
  blk_id: null,
  rsdt_id: null,
  rsdt2_id: null,
  prc_id: null,
  number: null,
};

/** 住所のどこをどの区域・番号に照合したか */
export type EvidenceMatched = {
  /** 照合した区域の名前 (照合の索引の表記) */
  area: string | null;
  /** 照合した番号 (「3-1」) */
  number: string | null;
  /** 区域と番号の間で読み飛ばした文字 (正規化した表記) */
  skipped: string | null;
};

export type Evidence = { point: EvidencePoint | null; matched: EvidenceMatched; steps: Step[] };

/** 段を足す。同じ段は 1 回だけ */
export const withStep = (r: MatchedResult, step: Step): MatchedResult =>
  r.steps?.includes(step) ? r : { ...r, steps: [...(r.steps ?? []), step] };

/** 段を使ったか (結果が変わったか) で足す */
export const stepIf = (before: MatchedResult, after: MatchedResult, step: Step): MatchedResult =>
  after === before ? after : withStep({ ...after, steps: before.steps }, step);

/** 区域の照合 (locate) で使った段 */
export const locateSteps = (found: Located): Step[] => [
  ...(found.via.start > 0 ? (["partway"] as const) : []),
  ...(found.via.skipped !== "" ? (["text_skipped"] as const) : []),
  ...(found.via.dropped ? (["prefix_dropped"] as const) : []),
  ...(found.via.added ? (["prefix_added"] as const) : []),
];

/** 区域の照合で取った点の出典 */
export const pointOf = (
  found: Located,
  lgCode: string,
  machiazaId: string | null,
): EvidencePoint => {
  const n = found.number;
  const keys = {
    lg_code: lgCode,
    machiaza_id: machiazaId,
    blk_id: n?.ids?.blk_id ?? null,
    rsdt_id: n?.ids?.rsdt_id ?? null,
    rsdt2_id: n?.ids?.rsdt2_id ?? null,
    prc_id: n?.ids?.prc_id ?? null,
    number: n === null ? null : n.parts.join("-"),
  };
  if (n === null)
    return {
      // 町字に自前の代表点が無いときは、上位の町字の点や下の点の平均などから求めた点で、出典は 1 つに決まらない
      dataset: found.via.own === false ? null : "address_br",
      point_type: found.via.own === false ? "machiaza_derived" : "machiaza",
      rank: null,
      keys,
    };
  return {
    dataset: n.source === "isj" ? "nlftp" : "address_br",
    point_type: n.pointType as EvidencePoint["point_type"],
    rank: n.rank,
    keys,
  };
};

/** 市区町村の代表点 */
export const cityPoint = (lgCode: string): EvidencePoint => ({
  dataset: "address_br",
  point_type: "city",
  rank: null,
  keys: { ...NO_KEYS, lg_code: lgCode },
});

export const evidenceOf = (r: MatchedResult): Evidence => ({
  point: r.evidence_point ?? null,
  matched: r.evidence_matched ?? { area: null, number: null, skipped: null },
  steps: r.steps ?? [],
});
