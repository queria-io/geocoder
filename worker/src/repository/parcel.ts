// 地番を引く。abrg/internal/repository/residential_parcel.go の FindParcelExact と
// convert.go の ParcelResultToNormalized の写し (upstream/UPSTREAM のコミット)。
// 上流は DuckDB の SQL、こちらは町字 1 つ分の行 (直下のデータセットの parcel の表) から選ぶ
import {
  DetermineMatchLevel,
  emptyIDs,
  emptyMachiaza,
  emptySA,
  FormatAddress,
  type MatchedResult,
  type Str,
} from "../model/model";

/** parcel の表の 1 行。地番の半角カナは全角にそろえてある */
export type ParcelRow = {
  lg_code: string;
  machiaza_id: string;
  prc_id: string;
  prc_num1: Str;
  prc_num2: Str;
  prc_num3: Str;
  lng: number | null;
  lat: number | null;
};

export const PARCEL_COLUMNS = [
  "lg_code",
  "machiaza_id",
  "prc_id",
  "prc_num1",
  "prc_num2",
  "prc_num3",
  "lng",
  "lat",
];

export type ParcelFilter = { PrcNum1: string; PrcNum2: string; PrcNum3: string };

/** 地番が丸ごと同じ行。枝番が空なら、枝番の無い行だけ */
export const findParcelExact = (rows: ParcelRow[], f: ParcelFilter): ParcelRow | null =>
  rows.find(
    (r) =>
      r.prc_num1 === f.PrcNum1 &&
      (f.PrcNum2 === "" ? r.prc_num2 === null : r.prc_num2 === f.PrcNum2) &&
      (f.PrcNum3 === "" ? r.prc_num3 === null : r.prc_num3 === f.PrcNum3),
  ) ?? null;

export const ParcelResultToNormalized = (r: ParcelRow): MatchedResult => {
  const sa = { ...emptySA(), prc_num1: r.prc_num1, prc_num2: r.prc_num2, prc_num3: r.prc_num3 };
  const ids = { ...emptyIDs(), lg_code: r.lg_code, machiaza_id: r.machiaza_id, prc_id: r.prc_id };
  return {
    matched_address: FormatAddress(sa),
    unmatched_address: null,
    match_level: DetermineMatchLevel(ids),
    score: 1,
    ids,
    structured_address: sa,
    coordinates: r.lng !== null && r.lat !== null ? [r.lng, r.lat] : null,
    machiaza: emptyMachiaza(),
  };
};
