// abrg/internal/model と matchlevel の写し (upstream/UPSTREAM のコミット)。当て方が使う分だけ
import { IsASCIIDigit } from "../char/char";
import type { EvidenceMatched, EvidencePoint, Step } from "../evidence";

export type MatchLevel =
  | "unknown"
  | "pref"
  | "city"
  | "machiaza"
  | "machiaza_detail"
  | "rsdtdsp_blk"
  | "rsdtdsp_rsdt"
  | "parcel";

export const All = "all";
export const UnknownMachiazaID = "0000000";
export const MaxChomeNumber = 100;

export type Category = "all" | "basic" | "rsdtdsp" | "parcel";
export type { NormalizeCategory } from "../normalize/address_type";

export type MatchQuery = { address: string; category: Category; pref: string; limit: number };

export type Str = string | null;

export type IDs = {
  lg_code: Str;
  machiaza_id: Str;
  rsdt_addr_flg: Str;
  blk_id: Str;
  rsdt_id: Str;
  rsdt2_id: Str;
  prc_id: Str;
};

export type StructuredAddress = {
  pref: Str;
  county: Str;
  city: Str;
  ward: Str;
  kyoto_st: Str;
  oaza_cho: Str;
  chome: Str;
  koaza: Str;
  machiaza_dist: Str;
  blk_num: Str;
  rsdt_num: Str;
  rsdt_num2: Str;
  prc_num1: Str;
  prc_num2: Str;
  prc_num3: Str;
};

export type MachiazaData = { hasChome: boolean; parcelCount: number; rsdtdspCount: number };

export type MatchedResult = {
  matched_address: string;
  /** null は残りが無いこと */
  unmatched_address: string[] | null;
  match_level: MatchLevel;
  score: number;
  ids: IDs;
  structured_address: StructuredAddress;
  coordinates: [number, number] | null;
  /**
   * 座標を取った点の段。上流には無い。番号まで当たったのにその点に座標が無く、町字の代表点で
   * 埋めたときだけ入れる。無ければ match_level と同じ段の点
   */
  coordinate_level?: CoordinateLevel;
  /** 座標を取った点の出典 (match_number の source)。上流には無い。照合の索引の番号の点で埋めたときだけ入れる */
  coordinate_source?: string | null;
  /**
   * 市区町村名の無い住所で、同じ町名で当たった市区町村の数。上流には無い。2 以上なら市区町村を
   * 推定しており、候補を人口の多い順に並べて返す
   */
  candidates?: number;
  /**
   * 旧市区町村名 (「員弁郡員弁町」) を今の市区町村名に読み替えたときの、読み替えた後の住所。上流には無い。
   * この後の段と照合の索引での引き直しは、元の住所ではなくこの住所から読む
   */
  former_address?: string;
  /** 上流の照合の後に使った段 (include=evidence)。上流には無い */
  steps?: Step[];
  /** 座標を取った点の出典と行の鍵 (include=evidence)。照合の索引で座標を引いたときだけ入れる */
  evidence_point?: EvidencePoint | null;
  /** 住所のどこをどの区域・番号に照合したか (include=evidence) */
  evidence_matched?: EvidenceMatched;
  machiaza: MachiazaData;
};

/** 座標を取った点の段。parcel_parent は国交省の位置参照情報の地番の親番の点 (上流には無い) */
export type CoordinateLevel = MatchLevel | "parcel_parent";

export const emptyIDs = (): IDs => ({
  lg_code: null,
  machiaza_id: null,
  rsdt_addr_flg: null,
  blk_id: null,
  rsdt_id: null,
  rsdt2_id: null,
  prc_id: null,
});

export const emptySA = (): StructuredAddress => ({
  pref: null,
  county: null,
  city: null,
  ward: null,
  kyoto_st: null,
  oaza_cho: null,
  chome: null,
  koaza: null,
  machiaza_dist: null,
  blk_num: null,
  rsdt_num: null,
  rsdt_num2: null,
  prc_num1: null,
  prc_num2: null,
  prc_num3: null,
});

export const emptyMachiaza = (): MachiazaData => ({
  hasChome: false,
  parcelCount: 0,
  rsdtdspCount: 0,
});

export const IsBaseMachiazaID = (id: string): boolean => id.length !== 7 || id.slice(4) === "000";

/** 住所の表記を組み立てる。数字で終わる部分と数字で始まる部分が並ぶところにはハイフンを挟む */
export const FormatAddress = (sa: StructuredAddress): string => {
  const has = (v: Str): v is string => v !== null && v !== "";
  const parts: [Str, string][] = [
    [sa.pref, ""],
    [sa.county, ""],
    [sa.city, ""],
    [sa.ward, ""],
    [sa.kyoto_st, ""],
    [sa.oaza_cho, ""],
    [sa.chome, ""],
    [sa.koaza, ""],
    [sa.blk_num, ""],
    [sa.rsdt_num, has(sa.blk_num) ? "-" : ""],
    [sa.rsdt_num2, "-"],
    [sa.prc_num1, ""],
    [sa.prc_num2, "-"],
    [sa.prc_num3, "-"],
  ];
  return parts.reduce((out, [v, prefix]) => {
    if (!has(v)) return out;
    if (prefix !== "") return out + prefix + v;
    const glue = out !== "" && IsASCIIDigit(out[out.length - 1]) && IsASCIIDigit(v[0]) ? "-" : "";
    return out + glue + v;
  }, "");
};

export const DetermineMatchLevel = (ids: IDs): MatchLevel => {
  if (ids.prc_id !== null) return "parcel";
  if (ids.rsdt_id !== null) return "rsdtdsp_rsdt";
  if (ids.blk_id !== null) return "rsdtdsp_blk";
  if (ids.machiaza_id !== null)
    return IsBaseMachiazaID(ids.machiaza_id) ? "machiaza" : "machiaza_detail";
  if (ids.lg_code !== null) return ids.lg_code.slice(2, 5) !== "000" ? "city" : "pref";
  return "unknown";
};

const detail: Record<MatchLevel, number> = {
  rsdtdsp_rsdt: 7,
  rsdtdsp_blk: 6,
  parcel: 5,
  machiaza_detail: 4,
  machiaza: 3,
  city: 2,
  pref: 1,
  unknown: 0,
};

export const Detail = (level: MatchLevel): number => detail[level];
