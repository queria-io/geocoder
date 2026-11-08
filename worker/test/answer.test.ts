import { describe, expect, it } from "vitest";

import {
  checkDigit,
  coordinatesLevel,
  forwardAnswer,
  meshCodes,
  parseInclude,
} from "../src/answer";
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

describe("coordinatesLevel", () => {
  it("ふだんは当たった段の点", () => {
    expect(coordinatesLevel(result({ match_level: "rsdtdsp_rsdt", coordinates: [1, 2] }))).toBe(
      "rsdtdsp_rsdt",
    );
  });

  it("町字の代表点で埋めたときは machiaza", () => {
    const r = result({ match_level: "parcel", coordinates: [1, 2], coordinate_level: "machiaza" });
    expect(coordinatesLevel(r)).toBe("machiaza");
  });

  it("座標が無ければ null", () => {
    expect(coordinatesLevel(result({ match_level: "parcel" }))).toBeNull();
  });
});

const none = { postal_code: null, estat_small_area_code: null };

describe("forwardAnswer", () => {
  it("既定は最小限の項目だけ", () => {
    const r = forwardAnswer(
      result({
        match_level: "machiaza",
        coordinates: [139.7, 35.6],
        ids: { ...emptyIDs(), lg_code: "131016" },
      }),
      new Set(),
      none,
    );
    expect(Object.keys(r)).toEqual([
      "matched_address",
      "unmatched_address",
      "lat",
      "lng",
      "match_level",
      "coordinates_level",
      "lg_code",
      "ambiguous",
      "candidates",
    ]);
    expect([r.ambiguous, r.candidates]).toEqual([false, 1]);
  });

  it("市区町村を推定した結果には印と候補の数を付ける", () => {
    const r = forwardAnswer(result({ candidates: 3 }), new Set(), none);
    expect([r.ambiguous, r.candidates]).toEqual([true, 3]);
  });

  it("codes は 6 桁のコードから都道府県と市区町村のコードを出す", () => {
    const r = forwardAnswer(
      result({ ids: { ...emptyIDs(), lg_code: "130001" } }),
      new Set(["codes"]),
      { ...none, postal_code: "1000005" },
    );
    expect(r.codes).toMatchObject({
      prefecture_code: "13",
      city_code: null,
      postal_code: "1000005",
      mesh_1km: null,
    });
  });
});

describe("evidence", () => {
  it("include=evidence のときだけ、点の出典・照合した区域と番号・使った段を返す", () => {
    const point = {
      dataset: "address_br" as const,
      point_type: "parcel" as const,
      rank: 1,
      keys: {
        lg_code: "082201",
        machiaza_id: "0001000",
        blk_id: null,
        rsdt_id: null,
        rsdt2_id: null,
        prc_id: "000280001000000",
        number: "28-10",
      },
    };
    const r = result({
      evidence_point: point,
      evidence_matched: { area: "千代田", number: "28-10", skipped: null },
      steps: ["city_inferred"],
    });
    expect(forwardAnswer(r, new Set(), none)).not.toHaveProperty("evidence");
    expect(forwardAnswer(r, new Set(["evidence"]), none).evidence).toEqual({
      point,
      matched: { area: "千代田", number: "28-10", skipped: null },
      steps: ["city_inferred"],
    });
  });

  it("根拠の無い結果は point を null、段を空にする", () => {
    expect(forwardAnswer(result({}), new Set(["evidence"]), none).evidence).toEqual({
      point: null,
      matched: { area: null, number: null, skipped: null },
      steps: [],
    });
  });

  it("include に evidence を渡せる", () => {
    expect(parseInclude("ids,evidence")).toEqual(new Set(["ids", "evidence"]));
  });
});

describe("meshCodes", () => {
  it("東京駅は 1km メッシュ 53394611", () => {
    expect(meshCodes(35.6812, 139.7671)).toEqual({
      mesh_1km: "53394611",
      mesh_500m: "533946113",
      mesh_250m: "5339461132",
    });
  });
});

describe("parseInclude", () => {
  it("カンマ区切りの組を読み、知らない名前なら null", () => {
    expect(parseInclude("structured_address, codes")).toEqual(
      new Set(["structured_address", "codes"]),
    );
    expect(parseInclude(undefined)).toEqual(new Set());
    expect(parseInclude("structured_address,foo")).toBeNull();
  });
});
