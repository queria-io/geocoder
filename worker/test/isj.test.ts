import { describe, expect, it } from "vitest";

import { parentNumber, withParcelParent, type IsjRow } from "../src/isj";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "茨城県つくば市学園南3丁目",
  unmatched_address: ["28-10"],
  match_level: "machiaza_detail",
  score: 1,
  ids: { ...emptyIDs(), lg_code: "082201", machiaza_id: "0051003" },
  structured_address: emptySA(),
  coordinates: [140.08913, 36.077563],
  machiaza: emptyMachiaza(),
  ...over,
});

const rows: Record<string, IsjRow[]> = {
  "0822010051003": [
    { block_number: "28", is_residential_address: false, lng: 140.0891, lat: 36.073632 },
    { block_number: "5", is_residential_address: true, lng: 140.1, lat: 36.1 },
  ],
};
const load = async (lg: string, id: string) => rows[lg + id] ?? [];

describe("withParcelParent", () => {
  it("町字止まりの地番の住所は親番の点にする", async () => {
    const r = await withParcelParent(result({}), load);
    expect(r.coordinates).toEqual([140.0891, 36.073632]);
    expect(r.coordinate_level).toBe("parcel_parent");
  });

  it("住居表示の街区の点は使わない", async () => {
    const r = await withParcelParent(result({ unmatched_address: ["5-1"] }), load);
    expect(r.coordinate_level).toBeUndefined();
  });

  it("番号の点まで当たっていれば触らない", async () => {
    const r = await withParcelParent(result({ match_level: "parcel" }), load);
    expect(r.coordinates).toEqual([140.08913, 36.077563]);
  });

  it("地番まで当たって点が無く町字の点で埋めたものは寄せる", async () => {
    const r = await withParcelParent(
      result({
        match_level: "parcel",
        coordinate_level: "machiaza_detail",
        unmatched_address: null,
        structured_address: { ...emptySA(), prc_num1: "28", prc_num2: "10" },
      }),
      load,
    );
    expect(r.coordinate_level).toBe("parcel_parent");
  });
});

describe("parentNumber", () => {
  it("残りの頭の数字", () => {
    expect(parentNumber(result({ unmatched_address: ["28-10"] }))).toBe("28");
    expect(parentNumber(result({ unmatched_address: ["ビル"] }))).toBeNull();
  });
});
