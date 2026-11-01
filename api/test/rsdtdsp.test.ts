import { describe, expect, it } from "vitest";

import { adjustMachiazaIDForChome } from "../src/matching/two_stage";
import { findResidentialBestMatch, type RsdtdspRow } from "../src/repository/rsdtdsp";

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
