import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { withParentPoint } from "../src/parent_point";
import type { BasicResult, CityResult } from "../src/repository/types";

const result = (machiazaId: string | null): MatchedResult => ({
  matched_address: "",
  unmatched_address: null,
  match_level: "parcel",
  score: 1,
  ids: { ...emptyIDs(), lg_code: "262102", machiaza_id: machiazaId },
  structured_address: emptySA(),
  coordinates: null,
  machiaza: emptyMachiaza(),
});
const towns: Record<string, Partial<BasicResult>> = {
  "0012001": { lon: null, lat: null },
  "0012000": { lon: 135.7, lat: 34.9 },
};
const town = async (_: string, id: string) => (towns[id] ?? null) as BasicResult | null;
const city = (lon: number | null) => () => ({ lon, lat: 34.95 }) as CityResult;

describe("withParentPoint", () => {
  it("小字に点が無ければ大字・町の点にする", async () => {
    const r = await withParentPoint(result("0012001"), town, city(135.6));
    expect(r.coordinates).toEqual([135.7, 34.9]);
    expect(r.coordinate_level).toBe("machiaza");
  });

  it("町字のどれにも点が無ければ市区町村の点にする", async () => {
    const r = await withParentPoint(result("0099001"), town, city(135.6));
    expect(r.coordinates).toEqual([135.6, 34.95]);
    expect(r.coordinate_level).toBe("city");
  });

  it("座標があれば触らない・どこにも点が無ければ座標なしのまま", async () => {
    const has = { ...result("0012001"), coordinates: [1, 2] as [number, number] };
    expect(await withParentPoint(has, town, city(135.6))).toBe(has);
    expect((await withParentPoint(result(null), town, city(null))).coordinates).toBeNull();
  });
});
