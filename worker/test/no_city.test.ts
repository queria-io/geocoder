import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import {
  locatingCity,
  MAX_LIMIT,
  numeralsOf,
  orderCandidates,
  townNameOf,
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
  const asking = (index: TownNameRow[], input: string) => {
    const asked: string[] = [];
    return withoutCity(unmatched(), input, names(index), Object.values(cities), async (a) => {
      asked.push(a);
      return [];
    }).then(() => asked);
  };

  it("住所の番号の頭の丁目を持つ市区町村に絞って当て直す", async () => {
    const index = [
      { ...row("天神", "072010"), chome: 1 },
      { ...row("天神", "072010"), chome: 2 },
      { ...row("天神", "202011"), chome: 5 },
    ];
    expect(await asking(index, "天神5-9-2")).toEqual(["長野県長野市天神5-9-2"]);
  });

  it("丁目まで同じなら、その丁目に次の番号の街区がある市区町村に絞る", async () => {
    const index = [
      { ...row("天神", "072010"), chome: 1, numbers: [1, 7] },
      { ...row("天神", "202011"), chome: 1, numbers: [1, 5, 8, 12] },
    ];
    expect(await asking(index, "天神1-8-35")).toEqual(["長野県長野市天神1-8-35"]);
  });

  it("丁目の無い町名は、頭の番号の地番がある市区町村に絞る", async () => {
    const index = [
      { ...row("新田", "072010"), numbers: [1, 2, 900] },
      { ...row("新田", "202011"), numbers: [1, 1928, 2000] },
    ];
    expect(await asking(index, "新田1928番1")).toEqual(["長野県長野市新田1928番1"]);
  });

  it("小字まで書いた住所は、その小字を持つ市区町村に絞る", async () => {
    const index = [
      { ...row("新田", "072010"), koaza: "小羽広", numbers: [1, 2000] },
      { ...row("新田", "202011"), koaza: "羽広" },
      { ...row("新田", "202011"), numbers: [1, 900] },
    ];
    expect(await asking(index, "大字新田字羽広1928番1")).toEqual(["長野県長野市新田字羽広1928番1"]);
  });

  it("小字まで書いた住所の番号は、その小字の町字の中で探す", async () => {
    const index = [
      { ...row("新田", "072010"), koaza: "羽広", numbers: [1] },
      { ...row("新田", "072010"), numbers: [1928] },
      { ...row("新田", "202011"), koaza: "羽広", numbers: [1928] },
    ];
    expect(await asking(index, "新田字羽広1928番1")).toEqual(["長野県長野市新田字羽広1928番1"]);
  });

  it("「番」「番地」の付いた頭の番号は丁目とみなさない", async () => {
    const index = [
      { ...row("天神", "072010"), chome: 3, numbers: [1] },
      { ...row("天神", "202011"), numbers: [3] },
    ];
    expect(await asking(index, "天神3番地5")).toEqual(["長野県長野市天神3番地5"]);
  });

  it("当て直して当たらなかった市区町村は候補の数に含めない", async () => {
    const found = await withoutCity(
      unmatched({ unmatched_address: ["天神1-9-1"] }),
      "天神1-9-1",
      names([row("天神", "072010"), row("天神", "202011")]),
      Object.values(cities),
      async (a) => (a.startsWith("長野県長野市") ? [hit("202011", "machiaza")] : []),
    );
    expect(found).toHaveLength(1);
    expect(found[0].candidates).toBeUndefined();
  });

  it("どの市区町村にも番号が無ければ、町名を持つ市区町村をすべて当て直す", async () => {
    const index = [
      { ...row("天神", "072010"), chome: 1, numbers: [1, 7] },
      { ...row("天神", "202011"), chome: 1, numbers: [1, 5] },
    ];
    expect(await asking(index, "天神1-9-1")).toHaveLength(2);
  });

  it("1 文字の町名も、後ろの丁目が実在する市区町村に絞る", async () => {
    const index = [
      { ...row("栄", "072010"), chome: 1 },
      { ...row("栄", "202011"), chome: 3 },
    ];
    expect(await asking(index, "栄3-20-29")).toEqual(["長野県長野市栄3-20-29"]);
  });

  it("候補の市区町村が上限より多ければ、人口の多い順に上限の数だけ当て直す", async () => {
    const many: CityResult[] = Array.from({ length: 20 }, (_, i) => ({
      lgCode: String(100000 + i),
      pref: "愛知県",
      county: null,
      city: `市${i}`,
      ward: null,
      lon: null,
      lat: null,
      population: i * 1000,
    }));
    const asked: string[] = [];
    const found = await withoutCity(
      unmatched({ unmatched_address: ["天神5-9-2"] }),
      "天神5-9-2",
      names(many.map((c) => row("天神", c.lgCode))),
      many,
      async (a) => {
        asked.push(a);
        const c = many.find((x) => a.startsWith(x.pref + x.city + "天神"));
        return c === undefined ? [] : [hit(c.lgCode, "machiaza")];
      },
    );
    expect(asked).toHaveLength(MAX_LIMIT);
    expect(asked).not.toContain("愛知県市0天神5-9-2");
    expect(found[0].ids.lg_code).toBe("100019");
    expect(found[0].candidates).toBe(20);
  });

  it("京都の通り名から書いた住所は、通り名の後ろの町名を持つ京都市の区で当て直す", async () => {
    const kamigyo: CityResult = {
      lgCode: "261025",
      pref: "京都府",
      county: null,
      city: "京都市",
      ward: "上京区",
      lon: null,
      lat: null,
      population: 83000,
    };
    const asked: string[] = [];
    const [r] = await withoutCity(
      unmatched(),
      "大宮通今出川上る観世町117",
      names([row("観世町", "261025"), row("観世町", "202011")]),
      [...Object.values(cities), kamigyo],
      async (a) => {
        asked.push(a);
        return a.startsWith("京都府") ? [hit("261025", "parcel")] : [];
      },
    );
    expect(asked).toEqual(["京都府京都市上京区大宮通今出川上る観世町117"]);
    expect(r.ids.lg_code).toBe("261025");
    expect(r.steps).toEqual(["kyoto_street_skipped", "city_inferred"]);
  });

  it("京都の通り名から書いた住所も、通り名の後ろの町名で長く当たった区だけを採る", async () => {
    const ward = (lgCode: string, name: string): CityResult => ({
      lgCode,
      pref: "京都府",
      county: null,
      city: "京都市",
      ward: name,
      lon: null,
      lat: null,
      population: 80000,
    });
    const at = (lgCode: string, oaza: string) => ({
      ...hit(lgCode, "machiaza"),
      structured_address: { ...emptySA(), oaza_cho: oaza },
    });
    const got = await withoutCity(
      unmatched(),
      "大宮通今出川上る観世町117",
      names([row("観世町", "261025"), row("観世町", "261033")]),
      [ward("261025", "上京区"), ward("261033", "左京区")],
      async (a) => [a.includes("上京区") ? at("261025", "観世町") : at("261033", "観世")],
    );
    expect(got.map((x) => [x.ids.lg_code, x.candidates])).toEqual([["261025", undefined]]);
  });

  it("市区町村を推定した結果に city_inferred の段を残す", async () => {
    const [r] = await withoutCity(
      unmatched(),
      "松川町字市坂３－１",
      names([row("松川町", "072010")]),
      Object.values(cities),
      async () => [hit("072010", "parcel")],
    );
    expect(r.steps).toEqual(["city_inferred"]);
  });

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

  it("当て直しで上流が市区町村までしか当てなかった市区町村も、町字から先を引き直して候補にする", async () => {
    const located = async (r: MatchedResult) => [
      { ...r, match_level: "machiaza" as const, ids: { ...r.ids, machiaza_id: "0051000" } },
    ];
    const got = await withoutCity(
      unmatched(),
      "学園南",
      names([row("学園南", "072010"), row("学園南", "202011")]),
      Object.values(cities),
      locatingCity(
        async (a) => [a.startsWith("福島県") ? hit("072010", "machiaza") : hit("202011", "city")],
        located,
      ),
    );
    expect(got.map((x) => [x.ids.lg_code, x.candidates])).toEqual([
      ["202011", 2],
      ["072010", 2],
    ]);
  });

  it("番号まで照合できても点が町字の代表点なら、親番の点を持つ候補より後ろに並べる", async () => {
    const got = await withoutCity(
      unmatched(),
      "松川町1",
      names([row("松川町", "072010"), row("松川町", "202011")]),
      Object.values(cities),
      async (a) => [
        a.startsWith("福島県")
          ? { ...hit("072010", "parcel"), coordinate_level: "parcel_parent" as const }
          : { ...hit("202011", "parcel"), coordinate_level: "machiaza" as const },
      ],
    );
    expect(got.map((x) => x.ids.lg_code)).toEqual(["072010", "202011"]);
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

describe("orderCandidates", () => {
  it("座標を取った点の細かい順に並べ、同じなら元の順を保つ", () => {
    const at = (
      lg: string,
      level: MatchedResult["match_level"],
      point: MatchedResult["coordinate_level"],
    ) => ({
      ...hit(lg, level),
      coordinate_level: point,
    });
    const got = orderCandidates([
      at("1", "parcel", "machiaza"),
      at("2", "machiaza_detail", "machiaza_detail"),
      at("3", "parcel", "parcel_parent"),
      at("4", "rsdtdsp_rsdt", "rsdtdsp_rsdt"),
      at("5", "parcel", "parcel_parent"),
    ]);
    expect(got.map((x) => x.ids.lg_code)).toEqual(["4", "3", "5", "2", "1"]);
  });
});

describe("locatingCity", () => {
  it("市区町村までの答えだけを引き直す", async () => {
    const asked: string[] = [];
    const got = await locatingCity(
      async () => [hit("072010", "city"), hit("202011", "parcel")],
      async (r, a) => {
        asked.push(a);
        return [{ ...r, match_level: "machiaza" }];
      },
    )("福島県福島市学園南");
    expect(asked).toEqual(["福島県福島市学園南"]);
    expect(got.map((x) => x.match_level)).toEqual(["machiaza", "parcel"]);
  });
});
