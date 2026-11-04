import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import {
  numeralsOf,
  townNameOf,
  withLeadingNoise,
  withoutCity,
  type TownNameRow,
} from "../src/no_city";
import type { CityResult } from "../src/repository/types";

const unmatched = (over: Partial<MatchedResult> = {}): MatchedResult => ({
  matched_address: "",
  unmatched_address: ["松川町字市坂3-1"],
  match_level: "unknown",
  score: 0,
  ids: emptyIDs(),
  structured_address: emptySA(),
  coordinates: null,
  machiaza: emptyMachiaza(),
  ...over,
});
const hit = (lgCode: string, level: MatchedResult["match_level"]): MatchedResult =>
  unmatched({
    matched_address: lgCode,
    unmatched_address: null,
    match_level: level,
    score: 1,
    ids: { ...emptyIDs(), lg_code: lgCode, machiaza_id: "0001000" },
  });
const cities: Record<string, CityResult> = {
  "072010": {
    lgCode: "072010",
    pref: "福島県",
    county: null,
    city: "福島市",
    ward: null,
    lon: null,
    lat: null,
    population: 282693,
  },
  "202011": {
    lgCode: "202011",
    pref: "長野県",
    county: null,
    city: "長野市",
    ward: null,
    lon: null,
    lat: null,
    population: 372760,
  },
};
const names =
  (rows: TownNameRow[]) =>
  async (key: string): Promise<TownNameRow[]> =>
    rows.filter((r) => r.name_key === key);
const row = (name: string, lg_code: string): TownNameRow => ({
  name_key: name.slice(0, 2),
  name,
  lg_code,
});

describe("withoutCity", () => {
  it("町名を持つ市区町村が 1 つなら、市区町村名を補って当て直す", async () => {
    const asked: string[] = [];
    const [r] = await withoutCity(
      unmatched(),
      "松川町字市坂３－１",
      names([row("松川町", "072010")]),
      Object.values(cities),
      async (a) => {
        asked.push(a);
        return [hit("072010", "parcel")];
      },
    );
    expect(asked).toEqual(["福島県福島市松川町字市坂3-1"]);
    expect(r.ids.lg_code).toBe("072010");
  });

  it("同じ町名を持つ市区町村が 2 つあれば、番地まで当たるのが 1 つでも両方を返し、細かい段まで当たった順に並べる", async () => {
    const got = await withoutCity(
      unmatched(),
      "松川町1",
      names([row("松川町", "072010"), row("松川町", "202011")]),
      Object.values(cities),
      async (a) => [a.startsWith("福島県") ? hit("072010", "parcel") : hit("202011", "machiaza")],
    );
    expect(got.map((x) => [x.ids.lg_code, x.candidates])).toEqual([
      ["072010", 2],
      ["202011", 2],
    ]);
  });

  it("同じ段まで当たった候補は人口の多い順に並べる", async () => {
    const got = await withoutCity(
      unmatched(),
      "松川町1",
      names([row("松川町", "072010"), row("松川町", "202011")]),
      Object.values(cities),
      async (a) => [a.startsWith("福島県") ? hit("072010", "parcel") : hit("202011", "parcel")],
    );
    expect(got.map((x) => x.ids.lg_code)).toEqual(["202011", "072010"]);
  });

  it("住所に書かれた長い町名で当たる市区町村が 1 つなら、それを採る", async () => {
    const at = (lgCode: string, oaza: string, chome: string | null) => ({
      ...hit(lgCode, "machiaza"),
      structured_address: { ...emptySA(), oaza_cho: oaza, chome },
    });
    const [r] = await withoutCity(
      unmatched(),
      "桧原3丁目13-17",
      names([row("桧原", "072010"), row("桧原", "202011")]),
      Object.values(cities),
      async (a) => [
        a.startsWith("福島県") ? at("072010", "桧原", "三丁目") : at("202011", "大字桧原", null),
      ],
    );
    expect(r.ids.lg_code).toBe("072010");
  });

  it("番地から読んだ丁目や住所に無い小字は、町名の長さに数えない", async () => {
    const at = (lgCode: string, oaza: string, chome: string | null, koaza: string | null) => ({
      ...hit(lgCode, "machiaza"),
      structured_address: { ...emptySA(), oaza_cho: oaza, chome, koaza },
    });
    const [r] = await withoutCity(
      unmatched(),
      "大原町5-20",
      names([row("大原町", "072010"), row("大原町", "202011")]),
      Object.values(cities),
      async (a) => [
        a.startsWith("福島県")
          ? at("072010", "大原町", "五丁目", null)
          : at("202011", "大原町", null, "字上"),
      ],
    );
    expect(r.candidates).toBe(2);
  });

  it("索引で長い町名を持つ市区町村だけを候補にする", async () => {
    const asked: string[] = [];
    await withoutCity(
      unmatched(),
      "前田8条17丁目9番12号",
      names([row("前田八条", "072010"), row("前田", "202011")]),
      Object.values(cities),
      async (a) => {
        asked.push(a);
        return [];
      },
    );
    expect(asked).toEqual(["福島県福島市前田8条17丁目9番12号"]);
  });

  it("都道府県まで当たっていれば、その都道府県の市区町村だけを候補にする", async () => {
    const asked: string[] = [];
    const [r] = await withoutCity(
      unmatched({ match_level: "pref", ids: { ...emptyIDs(), lg_code: "070009" } }),
      "福島県松川町1",
      names([row("松川町", "072010"), row("松川町", "202011")]),
      Object.values(cities),
      async (a) => {
        asked.push(a);
        return [hit("072010", "parcel")];
      },
    );
    expect(asked).toEqual(["福島県福島市松川町1"]);
    expect(r.ids.lg_code).toBe("072010");
  });

  it("市区町村まで当たっていれば何もしない", async () => {
    const r = hit("072010", "city");
    const got = await withoutCity(
      r,
      "福島県福島市松川町1",
      names([]),
      Object.values(cities),
      async () => {
        throw new Error("当て直さない");
      },
    );
    expect(got).toEqual([r]);
  });

  it("町名と同じ頭 2 文字でも、住所の頭に名前が無い行は候補にしない", async () => {
    const [r] = await withoutCity(
      unmatched(),
      "松川1",
      names([row("松川町", "072010")]),
      Object.values(cities),
      async () => {
        throw new Error("当て直さない");
      },
    );
    expect(r.match_level).toBe("unknown");
  });
});

describe("townNameOf", () => {
  it("全角・空白・頭の「大字」・「ヶ」をそろえる", () => {
    expect(townNameOf("大字 霞ヶ関１")).toBe("霞ケ関1");
  });
});

describe("withoutCity の区と余計な文字", () => {
  const sapporo: CityResult = {
    lgCode: "011061",
    pref: "北海道",
    county: null,
    city: "札幌市",
    ward: "西区",
    lon: null,
    lat: null,
  };
  it("市名を省いた政令市の区は、その区を持つ市が 1 つなら補う", async () => {
    const asked: string[] = [];
    const [r] = await withoutCity(
      unmatched({ match_level: "pref", ids: { ...emptyIDs(), lg_code: "010006" } }),
      "北海道西区西野６条",
      names([]),
      [sapporo],
      async (a) => {
        asked.push(a);
        return [hit("011061", "machiaza")];
      },
    );
    expect(asked).toEqual(["北海道札幌市西区西野6条"]);
    expect(r.ids.lg_code).toBe("011061");
  });

  it("都道府県名の前の余計な文字を外して当て直す", async () => {
    const asked: string[] = [];
    const r = await withLeadingNoise(unmatched(), "ｼ静岡県浜松市中央区元城町103-2", async (a) => {
      asked.push(a);
      return [hit("221384", "parcel")];
    });
    expect(asked).toEqual(["静岡県浜松市中央区元城町103-2"]);
    expect(r.ids.lg_code).toBe("221384");
  });
});

describe("町名の数字", () => {
  it("「八条」「十七丁目」を算用数字にする", () => {
    expect(numeralsOf("前田八条十七丁目")).toBe("前田8条17丁目");
    expect(numeralsOf("北二十一条")).toBe("北21条");
  });

  it("住所が算用数字でも、漢数字の町名の市区町村を候補にする", async () => {
    const asked: string[] = [];
    await withoutCity(
      unmatched(),
      "北1条西2丁目",
      names([row("北一条西", "072010")]),
      Object.values(cities),
      async (a) => {
        asked.push(a);
        return [];
      },
    );
    expect(asked).toEqual(["福島県福島市北1条西2丁目"]);
  });
});
