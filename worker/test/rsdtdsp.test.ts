import { describe, expect, it } from "vitest";

import { Match } from "../src/matching/match_core";
import { NewMatcher } from "../src/matching/matcher";
import { adjustMachiazaIDForChome } from "../src/matching/two_stage";
import { memoryRepository } from "../src/repository/memory";
import { findResidentialBestMatch, type RsdtdspRow } from "../src/repository/rsdtdsp";
import { toBasic, toCity, toPref, type TownRow } from "../src/repository/town";

const row = (blk: string, rsdt: string | null, rsdt2: string | null = null): RsdtdspRow => ({
  lg_code: "131016",
  machiaza_id: "0001001",
  blk_id: blk.padStart(3, "0"),
  rsdt_id: rsdt?.padStart(3, "0") ?? null,
  rsdt2_id: rsdt2,
  blk_num: blk,
  rsdt_num: rsdt,
  rsdt_num2: rsdt2,
  lng: 139.7,
  lat: 35.6,
});
const rows = [row("1", null), row("1", "3"), row("1", "3", "2"), row("2", null)];

describe("findResidentialBestMatch", () => {
  it("いちばん細かく当たる行を選ぶ", () => {
    const f = { BlkNum: "1", RsdtNum: "3", RsdtNum2: "2" };
    expect(findResidentialBestMatch(rows, f)?.level).toBe(3);
    expect(findResidentialBestMatch(rows, { ...f, RsdtNum2: "" })?.level).toBe(2);
    expect(findResidentialBestMatch(rows, { ...f, RsdtNum: "9", RsdtNum2: "" })?.level).toBe(1);
  });

  it("街区が無ければ null", () => {
    expect(findResidentialBestMatch(rows, { BlkNum: "5", RsdtNum: "", RsdtNum2: "" })).toBeNull();
  });
});

describe("adjustMachiazaIDForChome", () => {
  it("末尾 3 桁を丁目にする", () => {
    expect(adjustMachiazaIDForChome("0043000", "2")).toBe("0043002");
    expect(adjustMachiazaIDForChome("0043000", "")).toBe("0043000");
    expect(adjustMachiazaIDForChome("0043000", "101")).toBe("0043000");
  });
});

describe("住居表示の段", () => {
  const town = (machiazaId: string, chome: string | null, rsdtdspCount: number): TownRow => ({
    lg_code: "271462",
    machiaza_id: machiazaId,
    pref_name: "大阪府",
    county_name: null,
    city_name: "堺市",
    ward_name: "北区",
    oaza_cho: "新金岡町",
    chome,
    koaza: null,
    kyoto_street: false,
    machiaza_dist: null,
    has_chome: true,
    rsdtdsp_count: rsdtdspCount,
    rsdt_addr_flg: "1",
    rsdt_addr_partial: false,
  });
  const at = (machiazaId: string, blk: string, rsdt: string | null, lng: number): RsdtdspRow => ({
    ...row(blk, rsdt),
    lg_code: "271462",
    machiaza_id: machiazaId,
    lng,
  });
  const matcher = () => {
    const cities = [
      toCity({
        lg_code: "271462",
        pref_code: "27",
        pref_name: "大阪府",
        county_name: null,
        city_name: "堺市",
        ward_name: "北区",
      }),
    ];
    const prefs = [toPref({ lg_code: "270008", pref_code: "27", pref_name: "大阪府" })];
    const towns = [town("0035001", "1丁", 1), town("0035005", "5丁", 1)].map(toBasic);
    const rsdtdsp = [at("0035001", "4", null, 1), at("0035005", "1", "4", 5)];
    return NewMatcher(memoryRepository(towns, cities, prefs, rsdtdsp), cities);
  };

  it("丁目まで当たった町字では、最初の番号を丁目と読み替えない", async () => {
    const [r] = await Match(matcher(), {
      address: "大阪府堺市北区新金岡町5丁1-4",
      category: "all",
      pref: "",
      limit: 1,
    });
    expect(r.matched_address).toBe("大阪府堺市北区新金岡町5丁1-4");
    expect(r.coordinates?.[0]).toBe(5);
  });

  it("「1番地4」と書かれた住居表示の住所も号まで当てる", async () => {
    const [r] = await Match(matcher(), {
      address: "大阪府堺市北区新金岡町5丁1番地4",
      category: "all",
      pref: "",
      limit: 1,
    });
    expect(r.match_level).toBe("rsdtdsp_rsdt");
    expect(r.coordinates?.[0]).toBe(5);
  });
});
