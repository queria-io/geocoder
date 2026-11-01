// API の答えに足す項目。当て方 (matching/) は上流の写しのままにして、外向けの形はここで作る
import type { MatchedResult, MatchLevel } from "./model/model";

/** 全国地方公共団体コードの検査数字。頭 5 桁から 6 桁目を出す */
export const checkDigit = (code5: string): string => {
  const sum = [...code5].reduce((s, d, i) => s + Number(d) * (6 - i), 0);
  return String((11 - (sum % 11)) % 10);
};

export const lgCodeOf = (code5: string | null): string | null =>
  code5 === null ? null : code5 + checkDigit(code5);

export type CoordinateLevel =
  | "rsdtdsp_rsdt"
  | "rsdtdsp_blk"
  | "parcel"
  | "machiaza"
  | "city"
  | "pref";

const pointOf: Record<MatchLevel, CoordinateLevel | null> = {
  unknown: null,
  pref: "pref",
  city: "city",
  machiaza: "machiaza",
  machiaza_detail: "machiaza",
  rsdtdsp_blk: "rsdtdsp_blk",
  rsdtdsp_rsdt: "rsdtdsp_rsdt",
  parcel: "parcel",
};

/** 座標を取った点の段。座標が無ければ null */
export const coordinateLevel = (r: MatchedResult): CoordinateLevel | null =>
  r.coordinates === null ? null : pointOf[r.coordinate_level ?? r.match_level];

export const ABR_ATTRIBUTION =
  "「アドレス・ベース・レジストリ」（デジタル庁）（https://dataset.address-br.digital.go.jp/）を加工して作成";

/** 1 件の正引きの答え */
export const forwardAnswer = (r: MatchedResult) => {
  const lg = r.ids.lg_code;
  return {
    matched_address: r.matched_address,
    unmatched_address: r.unmatched_address,
    match_level: r.match_level,
    score: r.score,
    country: "JP" as const,
    prefecture_code: lg?.slice(0, 2) ?? null,
    city_code: lg !== null && lg.slice(2, 5) !== "000" ? lg.slice(0, 5) : null,
    lg_code: lg,
    machiaza_id: r.ids.machiaza_id,
    rsdt_addr_flg: r.ids.rsdt_addr_flg,
    structured_address: r.structured_address,
    lng: r.coordinates?.[0] ?? null,
    lat: r.coordinates?.[1] ?? null,
    coordinate_level: coordinateLevel(r),
  };
};

/** 読んだ表のファイル名 (パスの最後) */
export const fileName = (key: string): string => key.slice(key.lastIndexOf("/") + 1);
