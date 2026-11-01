import { describe, expect, it } from "vitest";

import { distanceM, nearestAddress } from "../src/nearby";
import type { RsdtdspRow } from "../src/repository/rsdtdsp";
import type { BasicResult } from "../src/repository/types";

const town = (
  machiazaId: string,
  chome: string,
  lat: number,
  lon: number,
  rsdtdspCount = 0,
): BasicResult => ({
  normalizedAddress: "",
  lgCode: "131016",
  machiazaId,
  rsdtAddrFlg: "1",
  pref: "東京都",
  county: null,
  city: "千代田区",
  ward: null,
  kyotoSt: null,
  oazaCho: "丸の内",
  chome,
  koaza: null,
  machiazaDist: null,
  hasChome: true,
  parcelCount: 0,
  rsdtdspCount,
  lon,
  lat,
});

const row = (
  machiaza_id: string,
  blk: string,
  rsdt: string | null,
  lat: number,
  lng: number,
): RsdtdspRow => ({
  lg_code: "131016",
  machiaza_id,
  blk_id: blk.padStart(3, "0"),
  rsdt_id: rsdt === null ? null : rsdt.padStart(3, "0"),
  rsdt2_id: null,
  blk_num: blk,
  rsdt_num: rsdt,
  rsdt_num2: null,
  lng,
  lat,
});

const towns = [
  town("0001001", "一丁目", 35.681, 139.765, 2),
  town("0001002", "二丁目", 35.679, 139.764),
];
const rows = async (_lg: string, mid: string) =>
  mid === "0001001"
    ? [row(mid, "9", "1", 35.6812, 139.7671), row(mid, "1", null, 35.683, 139.765)]
    : [];

describe("nearestAddress", () => {
  it("近くの住居の点まで寄せる", async () => {
    const r = await nearestAddress(towns, rows, 35.6813, 139.7672);
    expect(r?.matched_address).toBe("東京都千代田区丸の内一丁目9-1");
    expect(r?.match_level).toBe("rsdtdsp_rsdt");
    expect(r?.distance_m).toBeLessThan(20);
  });

  it("番号の点が遠ければ町字の代表点を返す", async () => {
    const r = await nearestAddress(towns, rows, 35.6789, 139.7641);
    expect(r?.matched_address).toBe("東京都千代田区丸の内二丁目");
    expect(r?.match_level).toBe("machiaza_detail");
  });

  it("座標のある町字が無ければ null", async () => {
    expect(await nearestAddress([], rows, 35.68, 139.76)).toBeNull();
  });
});

describe("distanceM", () => {
  it("緯度 0.001 度はおよそ 111m", () => {
    expect(distanceM(35, 139, 35.001, 139)).toBe(111);
  });
});
