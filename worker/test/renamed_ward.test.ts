import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { withRenamedWard } from "../src/renamed_ward";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "静岡県浜松市",
  unmatched_address: ["浜北区貴布祢1"],
  match_level: "city",
  score: 0.5,
  ids: { ...emptyIDs(), lg_code: "221309" },
  structured_address: emptySA(),
  coordinates: [137.73, 34.71],
  machiaza: emptyMachiaza(),
  ...over,
});
const town = (lgCode: string, address: string): MatchedResult =>
  result({
    matched_address: address,
    unmatched_address: null,
    match_level: "parcel",
    score: 1,
    ids: { ...emptyIDs(), lg_code: lgCode, machiaza_id: "0001000" },
  });

describe("withRenamedWard", () => {
  it("旧区の名前は今の区に読み替えて当て直す", async () => {
    const asked: string[] = [];
    const r = await withRenamedWard(result({}), "静岡県浜松市浜北区貴布祢1", async (a) => {
      asked.push(a);
      return [town("221384", "静岡県浜松市浜名区貴布祢1")];
    });
    expect(asked).toEqual(["静岡県浜松市浜名区貴布祢1"]);
    expect(r.ids.lg_code).toBe("221384");
  });

  it("引き継いだ区が 2 つあり、同じ強さで両方に当たれば読み替えない", async () => {
    const r = result({ unmatched_address: ["北区本町1"] });
    const got = await withRenamedWard(r, "静岡県浜松市北区本町1", async (a) => [
      a.includes("中央区") ? town("221384", a) : town("221392", a),
    ]);
    expect(got).toBe(r);
  });

  it("町字まで当たった住所と、旧区でない住所はそのまま", async () => {
    const hit = town("221384", "静岡県浜松市浜名区貴布祢1");
    expect(await withRenamedWard(hit, "静岡県浜松市浜北区貴布祢1", async () => [])).toBe(hit);
    const r = result({});
    expect(await withRenamedWard(r, "静岡県浜松市中央区1", async () => [hit])).toBe(r);
  });
});
