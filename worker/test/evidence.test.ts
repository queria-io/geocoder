import { describe, expect, it } from "vitest";

import { cityPoint, locateSteps, pointOf, stepIf, withStep } from "../src/evidence";
import type { Located } from "../src/locate/locate";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";

const result = (over: Partial<MatchedResult> = {}): MatchedResult => ({
  matched_address: "",
  unmatched_address: null,
  match_level: "machiaza",
  score: 1,
  ids: emptyIDs(),
  structured_address: emptySA(),
  coordinates: null,
  machiaza: emptyMachiaza(),
  ...over,
});

const via = { start: 0, skipped: "", dropped: false, added: false, own: null };

describe("steps", () => {
  it("同じ段は 1 回だけ足す", () => {
    const r = withStep(result(), "city_inferred");
    expect(withStep(r, "city_inferred")).toBe(r);
    expect(withStep(r, "number_tail").steps).toEqual(["city_inferred", "number_tail"]);
  });

  it("結果が変わらなければ段を足さず、変われば前の段を引き継いで足す", () => {
    const before = result({ steps: ["city_inferred"] });
    expect(stepIf(before, before, "aza_skipped")).toBe(before);
    const after = result({ score: 0.9 });
    expect(stepIf(before, after, "aza_skipped").steps).toEqual(["city_inferred", "aza_skipped"]);
  });

  it("区域の照合で使った段を、読み方から決める", () => {
    expect(locateSteps({ via } as Located)).toEqual([]);
    expect(
      locateSteps({
        via: { ...via, start: 2, skipped: "3-", dropped: true, added: true },
      } as Located),
    ).toEqual(["partway", "text_skipped", "prefix_dropped", "prefix_added"]);
  });
});

describe("pointOf", () => {
  it("位置参照情報の番号の点は nlftp", () => {
    const found = {
      point: [140, 40],
      area: "本町",
      machiazaId: null,
      number: {
        rank: 6,
        point: [140, 40],
        machiazaId: null,
        pointType: "block",
        source: "isj",
        parts: ["3", "1"],
      },
      rest: "",
      via,
    } as Located;
    expect(pointOf(found, "011011", null)).toEqual({
      dataset: "nlftp",
      point_type: "block",
      rank: 6,
      keys: { ...cityPoint("011011").keys, number: "3-1" },
    });
  });

  it("番号の無い区域の点は、区域そのものの点か下の町字の点の平均か", () => {
    const area = (own: boolean) =>
      ({
        point: [140, 40],
        area: "本町",
        machiazaId: "0001000",
        number: null,
        rest: "",
        via: { ...via, own },
      }) as Located;
    expect(pointOf(area(true), "011011", "0001000").point_type).toBe("machiaza");
    expect(pointOf(area(false), "011011", "0001000").point_type).toBe("machiaza_derived");
  });
});
