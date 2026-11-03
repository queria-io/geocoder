import { describe, expect, it } from "vitest";

import { Match } from "../src/matching/match_core";
import { NewMatcher } from "../src/matching/matcher";
import { memoryRepository } from "../src/repository/memory";
import type { ParcelRow } from "../src/repository/parcel";
import { toBasic, toCity, toPref, type TownRow } from "../src/repository/town";

// 丁目のある町 (高柳と高柳一丁目) で、丁目の無い町の地番を当てる
const town = (machiazaId: string, chome: string | null, parcelCount: number): TownRow => ({
  lg_code: "122173",
  machiaza_id: machiazaId,
  pref_name: "千葉県",
  county_name: null,
  city_name: "柏市",
  ward_name: null,
  oaza_cho: "高柳",
  chome,
  koaza: null,
  kyoto_street: false,
  machiaza_dist: null,
  has_chome: true,
  rsdtdsp_count: 0,
  rsdt_addr_flg: "0",
  rsdt_addr_partial: false,
  parcel_count: parcelCount,
});
const parcel = (machiazaId: string, n1: string, n2: string | null, lng: number): ParcelRow => ({
  lg_code: "122173",
  machiaza_id: machiazaId,
  prc_id: n1.padStart(5, "0") + (n2 ?? "").padStart(5, "0") + "00000",
  prc_num1: n1,
  prc_num2: n2,
  prc_num3: null,
  lng,
  lat: 35.8,
});

const matcher = () => {
  const cities = [
    toCity({
      lg_code: "122173",
      pref_code: "12",
      pref_name: "千葉県",
      county_name: null,
      city_name: "柏市",
      ward_name: null,
    }),
  ];
  const prefs = [toPref({ lg_code: "120006", pref_code: "12", pref_name: "千葉県" })];
  const towns = [town("0151000", null, 3), town("0151001", "一丁目", 1)].map(toBasic);
  const parcels = [
    parcel("0151000", "1762", "10", 1),
    parcel("0151000", "10", null, 2),
    parcel("0151000", "5", null, 3),
    parcel("0151001", "5", null, 4),
  ];
  return NewMatcher(memoryRepository(towns, cities, prefs, [], parcels), cities);
};
const lng = async (address: string) =>
  (await Match(matcher(), { address, category: "all", pref: "", limit: 1 }))[0]?.coordinates?.[0];

describe("丁目のある町の地番", () => {
  it("丁目にならない本番号 (1762) を落として枝番 (10) に当てない", async () => {
    expect(await lng("千葉県柏市高柳1762番10")).toBe(1);
  });

  it("最初の番号を丁目と読んだら、その丁目の町字の地番を探す", async () => {
    expect(await lng("千葉県柏市高柳1-5")).toBe(4);
  });
});
