// 地番の住所の点を、国交省の街区レベル位置参照情報の親番の点で埋める。上流には無い段。
// ABR の地番は座標の付く筆が一部だけで、地番まで当たらない・当たっても点が無いと町字の代表点になる
// (数百 m ずれる)。位置参照情報は親番 (「28番地10」の「28」) ごとに点を持つので、そこまで寄せる
import { coordinatesLevel } from "./answer";
import type { CoordinateLevel, MatchedResult } from "./model/model";

/** 直下のデータセットの isj_block の表の 1 行 */
export type IsjRow = {
  block_number: string;
  is_residential_address: boolean;
  lng: number | null;
  lat: number | null;
};

export const ISJ_COLUMNS = ["block_number", "is_residential_address", "lng", "lat"];

export const PARCEL_PARENT: CoordinateLevel = "parcel_parent";

export const ISJ_ATTRIBUTION = "「街区レベル位置参照情報」（国土交通省）を加工して作成";

/** 町字の代表点 (または点が無い) まで落ちたもの */
const atMachiaza = (r: MatchedResult): boolean => {
  const level = coordinatesLevel(r) ?? r.match_level;
  return level === "machiaza" || level === "machiaza_detail";
};

/**
 * 地番の親番。地番まで当たっていればその地番 1、町字止まりなら残りの頭の番号。
 * 番号の後ろは終わり・「-」・「番」だけを認める (「2F」や「9丁目28」の頭の数字は親番ではない)
 */
export const parentNumber = (r: MatchedResult): string | null =>
  r.structured_address.prc_num1 ??
  /^(\d+)(?=$|-|番)/.exec(r.unmatched_address?.[0] ?? "")?.[1] ??
  null;

export const withParcelParent = async (
  r: MatchedResult,
  load: (lgCode: string, machiazaId: string) => Promise<IsjRow[]>,
): Promise<MatchedResult> => {
  const { lg_code: lgCode, machiaza_id: machiazaId } = r.ids;
  const num = parentNumber(r);
  if (!atMachiaza(r) || !lgCode || !machiazaId || num === null) return r;
  // 小字の町字に親番の点が無ければ、同じ大字・町 (末尾 000) の町字で探す。
  // 丁目の町字は末尾 3 桁が丁目なので、丁目の無い大字・町の点には寄せない
  const base = machiazaId.slice(0, 4) + "000";
  const ids = r.structured_address.chome === null ? [...new Set([machiazaId, base])] : [machiazaId];
  for (const id of ids) {
    const hit = (await load(lgCode, id))
      .filter((x) => !x.is_residential_address && x.block_number === num)
      .map((x) => (x.lng !== null && x.lat !== null ? ([x.lng, x.lat] as [number, number]) : null))
      .find((p) => p !== null);
    if (hit) return { ...r, coordinates: hit, coordinate_level: PARCEL_PARENT };
  }
  return r;
};
