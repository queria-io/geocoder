// 当たったのに座標の無い答えを、点のある親の点で埋める。上流は座標を null のまま返す。
// 小字に代表点が無い、大字・町にも無い、区の再編で市区町村の行に点が無い、などで起きる
import type { MatchedResult } from "./model/model";
import type { BasicResult, CityResult } from "./repository/types";

const withPoint = (
  r: MatchedResult,
  p: { lon: number | null; lat: number | null } | null | undefined,
  level: "machiaza" | "city",
): MatchedResult | null =>
  p?.lon != null && p.lat != null
    ? { ...r, coordinates: [p.lon, p.lat], coordinate_level: level }
    : null;

/** 町字そのもの → 大字・町 (町字 ID の末尾 3 桁を 000) → 市区町村 の順に、点のある最初のもの */
export const withParentPoint = async (
  r: MatchedResult,
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>,
  city: (lgCode: string) => CityResult | undefined,
): Promise<MatchedResult> => {
  const { lg_code: lgCode, machiaza_id: machiazaId } = r.ids;
  if (r.coordinates !== null || !lgCode) return r;
  const ids = machiazaId ? [...new Set([machiazaId, machiazaId.slice(0, 4) + "000"])] : [];
  for (const id of ids) {
    const hit = withPoint(r, await town(lgCode, id), "machiaza");
    if (hit) return hit;
  }
  return withPoint(r, city(lgCode), "city") ?? r;
};
