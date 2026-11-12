import { describe, expect, it } from "vitest";
import { cityIndex, numbersOf, type MatchAreaRow } from "../src/locate/index";
import { candidates, EMPTY_NUMBERS, locate, remainder, type Numbers } from "../src/locate/locate";
import { norm, numberKey } from "../src/locate/norm";
import { type LocateDeps, withLocated } from "../src/locate/result";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";

describe("norm", () => {
  it("漢数字・区切り・省略できる字をそろえる", () => {
    expect(norm("大字三ケ島字二十三番地の四")).toBe("3島23-4");
    expect(norm("霞が関一丁目２番３号")).toBe("霞関1-2-3-");
    expect(norm("１ー２")).toBe("1-2");
  });
  it("漢数字の間の「の」は区切り", () => expect(norm("本町三の五")).toBe("本町3-5"));
  it("住所では丁目に印を付けられる", () =>
    expect(norm("松戸字三丁目１７９１番１", true)).toBe("松戸3=1791-1"));
  it("住所に書かれた「=」は丁目の印にしない", () =>
    expect(norm("本町１＝２", true)).toBe("本町1-2"));
  it("番号の部分をつなぐ", () => expect(numberKey(["12", null, "３"])).toBe("12-3"));
});

const area = (
  id: number,
  name: string,
  machiaza: string | null,
  pt: [number, number] | null,
  numbering: string | null = null,
): MatchAreaRow => ({
  area_id: id,
  lg_code: "011011",
  machiaza_id: machiaza,
  name,
  numbering_name: numbering,
  own_point: machiaza !== null && pt !== null,
  lng: pt?.[0] ?? null,
  lat: pt?.[1] ?? null,
});

describe("locate", () => {
  const index = cityIndex([
    area(1, "本町一丁目", "0001001", [140, 40]),
    area(2, "本町", "0001000", [141, 41]),
    area(3, "本町字上野", "0001002", [142, 42], "本町"),
  ]);
  const nums = new Map<string, Numbers>([
    [
      "本町1-",
      numbersOf({
        rsdt: [
          {
            lg_code: "011011",
            machiaza_id: "0001001",
            blk_id: "001",
            rsdt_id: "002",
            rsdt2_id: null,
            blk_num: "2",
            rsdt_num: "3",
            rsdt_num2: null,
            lng: 140.1,
            lat: 40.1,
          },
        ],
        parcel: [],
        numbers: [],
      }),
    ],
    [
      "本町",
      numbersOf({
        rsdt: [],
        parcel: [],
        numbers: [
          {
            area_id: 2,
            num: "10",
            point_type: "parcel",
            source: "abr",
            rank: 1,
            machiaza_id: "0001002",
            lng: 141.5,
            lat: 41.5,
          },
        ],
      }),
    ],
  ]);
  const at = (rest: string, markChome = false) =>
    locate(
      norm(rest, markChome),
      index.areas,
      (k) => nums.get(k) ?? { has: false, points: new Map() },
    );
  const marked = (rest: string) => at(rest, true);

  it("丁目に印を付けても、丁目の区域は同じに引く", () => {
    expect(marked("本町一丁目2番3号")?.point).toEqual([140.1, 40.1]);
  });
  it("住所の末尾の丁目も地番として読まない", () => {
    expect(marked("本町字十丁目")?.number).toBeNull();
  });
  it("区域に無い丁目は地番として読まず、読み飛ばして後ろの番号を引く", () => {
    const r = marked("本町字三丁目10番");
    expect(r?.point).toEqual([141.5, 41.5]);
    expect(r?.number?.parts).toEqual(["10"]);
  });
  it("2 つ目より後ろの丁目と書かれた数字は番号に含めない", () => {
    const row = (num: string, lng: number) => ({
      area_id: 2,
      num,
      point_type: "parcel",
      source: "abr",
      rank: 1,
      machiaza_id: "0001000",
      lng,
      lat: 41,
    });
    const both = numbersOf({
      rsdt: [],
      parcel: [],
      numbers: [row("10", 141.5), row("10-3", 141.7)],
    });
    const r = locate(norm("本町10番3丁目", true), index.areas, (k) =>
      k === "本町" ? both : { has: false, points: new Map() },
    );
    expect(r?.number?.parts).toEqual(["10"]);
  });
  it("頭から読んだ区域に番号の点が無くても、途中から読んだ別の区域の番号を採らない", () => {
    const both = cityIndex([
      area(1, "東本町", "0002000", [140, 40]),
      area(2, "本町", "0001000", [141, 41]),
    ]);
    const five = numbersOf({
      rsdt: [],
      parcel: [],
      numbers: [
        {
          area_id: 2,
          num: "5",
          point_type: "parcel",
          source: "abr",
          rank: 1,
          machiaza_id: "0001000",
          lng: 141.5,
          lat: 41.5,
        },
      ],
    });
    for (const a of ["東本町5", "東本町5番地", "東本町字中5"]) {
      const r = locate(norm(a, true), both.areas, (k) =>
        k === "本町" ? five : { has: false, points: new Map() },
      );
      expect(r?.area).toBe("東本町");
      expect(r?.point).toEqual([140, 40]);
    }
  });
  it("頭から読んだ区域の名前より後ろから始まる区域は、途中から読む", () => {
    const kyoto = cityIndex([
      area(1, "大黒町", "0003000", [140, 40]),
      area(2, "塗師屋町", "0004000", [141, 41]),
    ]);
    const n585 = numbersOf({
      rsdt: [],
      parcel: [],
      numbers: [
        {
          area_id: 2,
          num: "585",
          point_type: "parcel",
          source: "abr",
          rank: 1,
          machiaza_id: "0004000",
          lng: 141.5,
          lat: 41.5,
        },
      ],
    });
    const r = locate(norm("大黒町通正面下ル塗師屋町585", true), kyoto.areas, (k) =>
      k === "塗師屋町" ? n585 : { has: false, points: new Map() },
    );
    expect(r?.point).toEqual([141.5, 41.5]);
  });
  it("頭から区域が読めなければ、途中から読む", () => {
    expect(at("上る本町10")?.point).toEqual([141.5, 41.5]);
  });
  it("読み飛ばす文字が建物名なら、後ろの番号を読まない", () => {
    expect(marked("本町グランドハイツ10")?.number).toBeNull();
    expect(marked("本町コーポ10")?.number).toBeNull();
    expect(marked("本町ABC10")?.number).toBeNull();
    expect(marked("本町字中10")?.number?.parts).toEqual(["10"]);
    expect(marked("本町ソデ山10")?.number?.parts).toEqual(["10"]);
    expect(marked("本町ハケノ山10")?.number?.parts).toEqual(["10"]);
  });
  it("照合の根拠に、読み始めた位置・読み飛ばした文字・甲乙丙丁の扱いを残す", () => {
    expect(at("本町字上野10")?.via).toMatchObject({
      start: 0,
      skipped: "",
      dropped: false,
      added: false,
    });
    expect(marked("本町字三丁目10番")?.via).toMatchObject({ start: 0, skipped: "3-" });
    expect(at("上る本町10")?.via.start).toBeGreaterThan(0);
    expect(at("本町一丁目")?.via).toMatchObject({ own: true });
  });
  it("「町目」も丁目と同じに扱う", () => expect(norm("松戸三町目1791", true)).toBe("松戸3=1791"));
  it("番号まで最も長く当たる点", () => {
    expect(at("本町一丁目2番3号")?.point).toEqual([140.1, 40.1]);
  });
  it("番号が無ければ区域の点", () => {
    expect(at("本町一丁目")?.point).toEqual([140, 40]);
  });
  it("起番でない小字の番号は、地番を振る区域で引く", () => {
    const r = at("本町字上野10");
    expect(r?.point).toEqual([141.5, 41.5]);
    expect(r?.machiazaId).toBe("0001002");
  });
  it("頭の甲乙丙丁の付いた番号に点が無ければ、字を外した番号で引く", () => {
    const r = at("本町甲10");
    expect(r?.point).toEqual([141.5, 41.5]);
    expect(r?.number?.parts).toEqual(["10"]);
    expect(r?.rest).toBe("甲-");
  });
  it("頭の甲乙丙丁の付いた番号に点があれば、字を外した番号より先に採る", () => {
    const row = (num: string, lng: number) => ({
      area_id: 2,
      num,
      point_type: "parcel",
      source: "abr",
      rank: 1,
      machiaza_id: "0001000",
      lng,
      lat: 41,
    });
    const both = numbersOf({
      rsdt: [],
      parcel: [],
      numbers: [row("10", 141.5), row("甲10", 141.7)],
    });
    const r = locate(norm("本町甲10"), index.areas, (k) =>
      k === "本町" ? both : { has: false, points: new Map() },
    );
    expect(r?.point).toEqual([141.7, 41]);
    expect(r?.number?.parts).toEqual(["甲10"]);
  });
  it("別の甲乙丙丁の付いた同じ番号があっても、字の無い番号は字を外して引く", () => {
    const row = (num: string, lng: number) => ({
      area_id: 2,
      num,
      point_type: "parcel",
      source: "abr",
      rank: 1,
      machiaza_id: "0001000",
      lng,
      lat: 41,
    });
    const both = numbersOf({
      rsdt: [],
      parcel: [],
      numbers: [row("10", 141.5), row("乙10", 141.7)],
    });
    const r = locate(norm("本町甲10"), index.areas, (k) =>
      k === "本町" ? both : { has: false, points: new Map() },
    );
    expect(r?.point).toEqual([141.5, 41]);
  });
  it("番号に甲乙丙丁が書かれていなければ、甲乙丙丁の付いた番号をすべて候補にする", () => {
    const row = (num: string, lng: number) => ({
      area_id: 2,
      num,
      point_type: "parcel",
      source: "abr",
      rank: 1,
      machiaza_id: "0001000",
      lng,
      lat: 41,
    });
    const both = numbersOf({
      rsdt: [],
      parcel: [],
      numbers: [row("甲10", 141.5), row("丙10", 141.7)],
    });
    const r = locate(norm("本町10"), index.areas, (k) =>
      k === "本町" ? both : { has: false, points: new Map() },
    );
    expect([r?.number?.parts, ...(r?.others ?? []).map((o) => o.number?.parts)]).toEqual([
      ["甲10"],
      ["丙10"],
    ]);
    expect(r?.rest).toBe("-");
  });
  it("読み飛ばす区域の名前と地番を振る区域を、番号を読む候補にする", () => {
    expect(candidates(norm("本町字上野10"), index.areas)).toContain("本町");
  });
  it("丁目と書かれた数字しか無ければ、番号を読む候補にしない", () => {
    expect(candidates(norm("本町字三丁目", true), index.areas)).not.toContain("本町");
    expect(candidates(norm("本町字三丁目10番", true), index.areas)).toContain("本町");
  });
});

describe("numbersOf", () => {
  it("住居表示の区域では、同じ番号の地番より住居表示の点を採る", () => {
    const n = numbersOf({
      rsdt: [
        {
          lg_code: "011011",
          machiaza_id: "0001001",
          blk_id: "001",
          rsdt_id: "002",
          rsdt2_id: null,
          blk_num: "2",
          rsdt_num: "3",
          rsdt_num2: null,
          lng: 140.1,
          lat: 40.1,
        },
      ],
      parcel: [
        {
          lg_code: "011011",
          machiaza_id: "0001001",
          prc_id: "000020000300000",
          prc_num1: "2",
          prc_num2: "3",
          prc_num3: null,
          lng: 140.9,
          lat: 40.9,
        },
      ],
      numbers: [],
    });
    expect(n.points.get("2-3")?.point).toEqual([140.1, 40.1]);
  });
});

describe("remainder", () => {
  it("市区町村名より後ろ", () =>
    expect(
      remainder("北海道札幌市中央区本町1-2", {
        pref: "北海道",
        county: null,
        city: "札幌市",
        ward: "中央区",
      }),
    ).toBe("本町1-2"));
});

describe("丁目を省いた大字・町", () => {
  // 学園南は丁目の町字だけが ABR にあり、丁目を省いた区域は大字・町の頭 4 桁に 000 を付けた町字 ID と
  // 丁目の点の平均を持つ
  const rows = [
    area(2, "学園南", "0051000", [140.08, 36.08]),
    area(3, "学園南1丁目", "0051001", [140.07, 36.07]),
    area(4, "学園南3丁目", "0051003", [140.09, 36.09]),
  ].map((r) => (r.machiaza_id === "0051000" ? { ...r, own_point: false } : r));
  const index = cityIndex(rows);

  it("丁目を省いた町名は大字・町の区域に当てる", () => {
    const found = locate("学園南", index.areas, () => EMPTY_NUMBERS);
    expect([found?.area, found?.machiazaId, found?.point]).toEqual([
      "学園南",
      "0051000",
      [140.08, 36.08],
    ]);
  });

  it("丁目まで書けば丁目の町字に当てる", () =>
    expect(locate(norm("学園南3丁目", true), index.areas, () => EMPTY_NUMBERS)?.machiazaId).toBe(
      "0051003",
    ));

  const city = {
    lgCode: "011011",
    pref: "茨城県",
    county: null,
    city: "つくば市",
    ward: null,
    lon: 140,
    lat: 36,
  };
  const deps: LocateDeps = {
    index: async () => index,
    numbers: async () => [],
    rsdt: async () => [],
    parcels: async () => [],
    town: async () => null,
    city: () => city,
  };
  const r: MatchedResult = {
    matched_address: "茨城県つくば市",
    unmatched_address: ["学園南"],
    match_level: "city",
    score: 1,
    ids: { ...emptyIDs(), lg_code: "011011" },
    structured_address: { ...emptySA(), pref: "茨城県", city: "つくば市" },
    coordinates: null,
    machiaza: emptyMachiaza(),
  };
  it("答えは町字 (machiaza) の段で、大字・町の名前を表記に入れる", async () => {
    const [got] = await withLocated(r, "つくば市学園南", deps);
    expect([
      got.match_level,
      got.matched_address,
      got.ids.machiaza_id,
      got.structured_address.oaza_cho,
      got.unmatched_address,
      got.evidence_point?.point_type,
    ]).toEqual(["machiaza", "茨城県つくば市学園南", "0051000", "学園南", null, "machiaza_derived"]);
  });

  it("町字の表に行の無い丁目の町字は、大字・町の名前にしない", async () => {
    const [got] = await withLocated(r, "つくば市学園南3丁目", deps);
    expect([got.match_level, got.structured_address.oaza_cho]).toEqual(["city", null]);
  });
});
