import { describe, expect, it } from "vitest";
import { cityIndex, numbersOf, type MatchAreaRow } from "../src/locate/index";
import { candidates, locate, remainder, type Numbers } from "../src/locate/locate";
import { norm, numberKey } from "../src/locate/norm";

describe("norm", () => {
  it("漢数字・区切り・省略できる字をそろえる", () => {
    expect(norm("大字三ケ島字二十三番地の四")).toBe("3島23-4");
    expect(norm("霞が関一丁目２番３号")).toBe("霞関1-2-3-");
    expect(norm("１ー２")).toBe("1-2");
  });
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
  const at = (rest: string) =>
    locate(norm(rest), index.areas, (k) => nums.get(k) ?? { has: false, points: new Map() });

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
  it("読み飛ばす区域の名前と地番を振る区域を、番号を読む候補にする", () => {
    expect(candidates(norm("本町字上野10"), index.areas)).toContain("本町");
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
