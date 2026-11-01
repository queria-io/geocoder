import { describe, expect, it } from "vitest";

import { checkDigit, coordinateLevel, forwardAnswer } from "../src/answer";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "",
  unmatched_address: null,
  match_level: "unknown",
  score: 1,
  ids: emptyIDs(),
  structured_address: emptySA(),
  coordinates: null,
  machiaza: emptyMachiaza(),
  ...over,
});

describe("checkDigit", () => {
  it("全国地方公共団体コードの 6 桁目を出す", () => {
    expect(["13101", "27146", "01100", "47382"].map(checkDigit)).toEqual(["6", "2", "2", "1"]);
  });
});

describe("coordinateLevel", () => {
  it("ふだんは当たった段の点", () => {
    expect(coordinateLevel(result({ match_level: "rsdtdsp_rsdt", coordinates: [1, 2] }))).toBe(
      "rsdtdsp_rsdt",
    );
    expect(coordinateLevel(result({ match_level: "machiaza_detail", coordinates: [1, 2] }))).toBe(
      "machiaza",
    );
  });

  it("町字の代表点で埋めたときは machiaza", () => {
    const r = result({ match_level: "parcel", coordinates: [1, 2], coordinate_level: "machiaza" });
    expect(coordinateLevel(r)).toBe("machiaza");
  });

  it("座標が無ければ null", () => {
    expect(coordinateLevel(result({ match_level: "parcel" }))).toBeNull();
  });
});

describe("forwardAnswer", () => {
  it("6 桁のコードから都道府県と市区町村のコードを出す", () => {
    const r = forwardAnswer(result({ ids: { ...emptyIDs(), lg_code: "131016" } }));
    expect(r).toMatchObject({ country: "JP", prefecture_code: "13", city_code: "13101" });
  });

  it("都道府県までなら市区町村のコードは null", () => {
    const r = forwardAnswer(result({ ids: { ...emptyIDs(), lg_code: "130001" } }));
    expect(r).toMatchObject({ prefecture_code: "13", city_code: null });
  });
});
