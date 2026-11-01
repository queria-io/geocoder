import { describe, expect, it } from "vitest";

import { buildCountyIndex, restoreCounty } from "../src/matching/omitted_county";
import type { CityRow } from "../src/repository/memory";

const city = (prefCode: string, county: string | null, name: string) =>
  ({ prefCode, county, city: name, ward: null }) as unknown as CityRow;

const index = buildCountyIndex([
  city("01", "石狩郡", "当別町"),
  city("01", "茅部郡", "森町"),
  city("22", "周智郡", "森町"),
  city("20", null, "大町市"),
  city("41", "杵島郡", "大町町"),
  city("01", "上川郡", "清水町"),
  city("01", "勇払郡", "清水町"),
]);

describe("restoreCounty", () => {
  it("郡を省いた町村に郡を足す", () => {
    expect(restoreCounty(index, "当別町春日町84-4", "01")).toBe("石狩郡当別町春日町84-4");
  });

  it("同じ名前の町は都道府県で分ける", () => {
    expect(restoreCounty(index, "森町森1", "22")).toBe("周智郡森町森1");
    expect(restoreCounty(index, "森町森川町1", "01")).toBe("茅部郡森町森川町1");
  });

  it("郡のある住所・郡の無い市・都道府県が分からないときは変えない", () => {
    expect(restoreCounty(index, "石狩郡当別町春日町", "01")).toBe("石狩郡当別町春日町");
    expect(restoreCounty(index, "大町市大町1", "20")).toBe("大町市大町1");
    expect(restoreCounty(index, "当別町春日町", "")).toBe("当別町春日町");
  });

  it("長い名前を先に見る (大町町を大町市と取り違えない)", () => {
    expect(restoreCounty(index, "大町町大町1", "41")).toBe("杵島郡大町町大町1");
  });

  it("同じ都道府県で郡が割れる名前は足さない", () => {
    expect(restoreCounty(index, "清水町1", "01")).toBe("清水町1");
  });
});
