import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { missPoint, missReason } from "../src/misses";

const result = (over: Partial<MatchedResult> = {}): MatchedResult => ({
  matched_address: "東京都千代田区紀尾井町1-3",
  unmatched_address: null,
  match_level: "rsdtdsp_rsdt",
  score: 1,
  ids: { ...emptyIDs(), lg_code: "131016" },
  structured_address: emptySA(),
  coordinates: [139.7, 35.6],
  machiaza: emptyMachiaza(),
  ...over,
});

describe("missReason", () => {
  it("番地まで照合でき、残りが無ければ記録しない", () => {
    expect(missReason([result()])).toBeNull();
  });

  it("結果なし・町字止まり・残り・候補が複数を分ける", () => {
    expect(missReason([])).toBe("none");
    expect(missReason([result({ match_level: "machiaza" })])).toBe("coarse");
    expect(missReason([result({ unmatched_address: ["ビル"] })])).toBe("remainder");
    expect(missReason([result({ candidates: 2 })])).toBe("ambiguous");
  });
});

describe("missPoint", () => {
  it("入力の住所と結果の段・残りを書く", () => {
    const p = missPoint("千代田区紀尾井町1-3ビル", [result({ unmatched_address: ["ビル"] })]);
    expect(p?.blobs).toEqual([
      "remainder",
      "千代田区紀尾井町1-3ビル",
      "rsdtdsp_rsdt",
      "東京都千代田区紀尾井町1-3",
      "ビル",
      "131016",
    ]);
  });
});
