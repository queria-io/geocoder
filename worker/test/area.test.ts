import { describe, expect, it } from "vitest";

import { areaFilter } from "../src/forward";
import type { CityResult } from "../src/repository/types";

const city = (lgCode: string, name: string, ward: string | null = null): CityResult => ({
  lgCode,
  pref: "神奈川県",
  county: null,
  city: name,
  ward,
  lon: null,
  lat: null,
});

const cities = [
  city("141003", "横浜市"),
  city("141011", "横浜市", "鶴見区"),
  city("141046", "横浜市", "中区"),
  city("141305", "川崎市"),
  city("141313", "川崎市", "川崎区"),
  city("142018", "横須賀市"),
];

describe("areaFilter", () => {
  it("地域が無ければ全部通す", () => {
    expect(areaFilter(cities, undefined)("131016")).toBe(true);
  });

  it("都道府県コードは頭 2 桁で絞る", () => {
    const inArea = areaFilter(cities, "14");
    expect(inArea("141046")).toBe(true);
    expect(inArea("131016")).toBe(false);
    expect(inArea(null)).toBe(false);
  });

  it("政令市のコードは区も含める", () => {
    const inArea = areaFilter(cities, "14100");
    expect(inArea("141003")).toBe(true);
    expect(inArea("141011")).toBe(true);
    expect(inArea("141046")).toBe(true);
    expect(inArea("141313")).toBe(false);
    expect(inArea("142018")).toBe(false);
  });

  it("区のコードはその区だけ", () => {
    const inArea = areaFilter(cities, "14104");
    expect(inArea("141046")).toBe(true);
    expect(inArea("141011")).toBe(false);
  });
});
