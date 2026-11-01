// 住居表示の番・号を引く。abrg/internal/repository/residential_parcel.go の FindResidentialBestMatch と
// convert.go の ResidentialResultToNormalized の写し (upstream/UPSTREAM のコミット)。
// 上流は DuckDB の SQL、こちらは町字 1 つ分の行 (直下のデータセットの rsdtdsp の表) から選ぶ
import {
  DetermineMatchLevel,
  emptyIDs,
  emptyMachiaza,
  emptySA,
  FormatAddress,
  type MatchedResult,
  type Str,
} from "../model/model";

/** rsdtdsp の表の 1 行。街区だけの行は rsdt_id・rsdt_num が null */
export type RsdtdspRow = {
  lg_code: string;
  machiaza_id: string;
  blk_id: string;
  rsdt_id: Str;
  rsdt2_id: Str;
  blk_num: Str;
  rsdt_num: Str;
  rsdt_num2: Str;
  lng: number | null;
  lat: number | null;
};

export const RSDTDSP_COLUMNS = [
  "lg_code",
  "machiaza_id",
  "blk_id",
  "rsdt_id",
  "rsdt2_id",
  "blk_num",
  "rsdt_num",
  "rsdt_num2",
  "lng",
  "lat",
];

/** rsdtdsp の表を絞る列の値 (lg_code と machiaza_id をつないだもの) */
export const machiazaKey = (lgCode: string, machiazaId: string): string => lgCode + machiazaId;

export type ResidentialFilter = { BlkNum: string; RsdtNum: string; RsdtNum2: string };

/** 1 は街区まで、2 は住居まで、3 は住居番号2 まで */
export type ResidentialMatchLevel = 1 | 2 | 3;
export type ResidentialBestResult = { row: RsdtdspRow; level: ResidentialMatchLevel };

const levelOf = (r: RsdtdspRow, f: ResidentialFilter): number => {
  if (
    f.RsdtNum !== "" &&
    f.RsdtNum2 !== "" &&
    r.rsdt_num === f.RsdtNum &&
    r.rsdt_num2 === f.RsdtNum2
  )
    return 3;
  if (f.RsdtNum !== "" && r.rsdt_num === f.RsdtNum && r.rsdt_num2 === null) return 2;
  if (r.rsdt_num === null && r.rsdt_num2 === null) return 1;
  return 0;
};

/** 町字 1 つ分の行から、いちばん細かく当たる行 (住居番号2、住居、街区の順)。同じ細かさなら表の順で先の行 */
export const findResidentialBestMatch = (
  rows: RsdtdspRow[],
  filter: ResidentialFilter,
): ResidentialBestResult | null =>
  rows
    .filter((r) => r.blk_num === filter.BlkNum)
    .map((row) => ({ row, level: levelOf(row, filter) }))
    .filter((x): x is ResidentialBestResult => x.level > 0)
    .reduce<ResidentialBestResult | null>(
      (best, x) => (best && best.level >= x.level ? best : x),
      null,
    );

export const ResidentialResultToNormalized = (r: RsdtdspRow): MatchedResult => {
  const sa = { ...emptySA(), blk_num: r.blk_num, rsdt_num: r.rsdt_num, rsdt_num2: r.rsdt_num2 };
  const ids = {
    ...emptyIDs(),
    lg_code: r.lg_code,
    machiaza_id: r.machiaza_id,
    blk_id: r.blk_id,
    rsdt_id: r.rsdt_id,
    rsdt2_id: r.rsdt2_id,
  };
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
