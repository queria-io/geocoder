import { describe, expect, it } from "vitest";

import { cityPoint, keptSteps, locateSteps, pointOf, stepIf, withStep } from "../src/evidence";
import type { Located } from "../src/locate/locate";
import { atPref } from "../src/locate/result";
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

  it("知らない種類・出典の点は、出典を示さない", () => {
    const of = (pointType: string, source: string) =>
      pointOf(
        {
          point: [140, 40],
          area: "本町",
          machiazaId: null,
          number: { rank: 9, point: [140, 40], machiazaId: null, pointType, source, parts: ["1"] },
          rest: "",
          via,
        } as Located,
        "011011",
        null,
      );
    expect(of("survey", "abr")).toBeNull();
    expect(of("parcel", "other")).toBeNull();
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
    expect(pointOf(area(true), "011011", "0001000")?.point_type).toBe("machiaza");
    expect(pointOf(area(false), "011011", "0001000")?.point_type).toBe("machiaza_derived");
  });
});

describe("keptSteps", () => {
  it("区域と番号を当て直す段は、索引で引き直したら外す", () => {
    expect(keptSteps(["former_city", "aza_skipped", "city_inferred", "number_tail"])).toEqual([
      "former_city",
      "city_inferred",
    ]);
    expect(keptSteps(undefined)).toEqual([]);
  });
});

describe("atPref", () => {
  const ibaraki = { lgCode: "080004", prefCode: "08", prefName: "茨城県", lon: 140.4, lat: 36.3 };

  it("都道府県だけ当たった答えに、都道府県の代表点を付ける", () => {
    const r = atPref(
      result({ match_level: "pref", ids: { ...emptyIDs(), lg_code: "080004" } }),
      ibaraki,
    );
    expect(r.coordinates).toEqual([140.4, 36.3]);
    expect(r.coordinate_level).toBe("pref");
    expect(r.evidence_point?.point_type).toBe("pref");
  });

  it("都道府県より細かく当たった答えや、代表点の無い都道府県はそのまま返す", () => {
    const city = result({ match_level: "city" });
    expect(atPref(city, ibaraki)).toBe(city);
    const pref = result({ match_level: "pref" });
    expect(atPref(pref, { ...ibaraki, lon: null, lat: null })).toBe(pref);
    expect(atPref(pref, undefined)).toBe(pref);
  });
});
