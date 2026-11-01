// geocoder の town・city・pref の表 (直下の models/main/mart) の行を、当て方が読む形にする
import { TextForDB } from "../transform/text";
import type { CityRow, PrefRow } from "./memory";
import type { BasicResult } from "./types";

export type TownRow = {
  lg_code: string;
  machiaza_id: string;
  pref_name: string;
  county_name: string | null;
  city_name: string;
  ward_name: string | null;
  oaza_cho: string | null;
  chome: string | null;
  koaza: string | null;
  kyoto_street: boolean;
  machiaza_dist: string | null;
  has_chome: boolean;
  rsdtdsp_count: number;
  rsdt_addr_flg: string;
  rsdt_addr_partial: boolean;
  lng?: number | null;
  lat?: number | null;
};

export const TOWN_COLUMNS = [
  "lg_code",
  "machiaza_id",
  "pref_name",
  "county_name",
  "city_name",
  "ward_name",
  "oaza_cho",
  "chome",
  "koaza",
  "kyoto_street",
  "machiaza_dist",
  "has_chome",
  "rsdtdsp_count",
  "rsdt_addr_flg",
  "rsdt_addr_partial",
  "lng",
  "lat",
];

export type CityTableRow = {
  lg_code: string;
  pref_code: string;
  pref_name: string;
  county_name: string | null;
  city_name: string;
  ward_name: string | null;
  lng?: number | null;
  lat?: number | null;
};

export type PrefTableRow = { lg_code: string; pref_code: string; pref_name: string };

/** 町字 1 行を上流の cache_machiaza の 1 行に。京都の通り名は koaza から kyoto_st へ移す */
export const toBasic = (t: TownRow): BasicResult => {
  const kyotoSt = t.kyoto_street ? t.koaza : null;
  const koaza = t.kyoto_street ? null : t.koaza;
  const parts = [t.county_name, t.city_name, t.ward_name, kyotoSt, t.oaza_cho, t.chome, koaza];
  return {
    normalizedAddress: TextForDB(parts.map((p) => p ?? "").join(""))[0],
    lgCode: t.lg_code,
    machiazaId: t.machiaza_id,
    // 一部だけ住居表示の町字は、住居表示と地番のどちらか決まらない (上流は 2 行あって印を null にする)
    rsdtAddrFlg: t.rsdt_addr_partial ? null : t.rsdt_addr_flg,
    pref: t.pref_name,
    county: t.county_name,
    city: t.city_name,
    ward: t.ward_name,
    kyotoSt,
    oazaCho: t.oaza_cho,
    chome: t.chome,
    koaza,
    machiazaDist: t.machiaza_dist,
    hasChome: t.has_chome,
    parcelCount: 0,
    rsdtdspCount: Number(t.rsdtdsp_count ?? 0),
    lon: t.lng ?? null,
    lat: t.lat ?? null,
  };
};

export const toCity = (c: CityTableRow): CityRow => ({
  lgCode: c.lg_code,
  prefCode: c.pref_code,
  pref: c.pref_name,
  county: c.county_name,
  city: c.city_name,
  ward: c.ward_name,
  lon: c.lng ?? null,
  lat: c.lat ?? null,
  normalizedAddress: TextForDB((c.county_name ?? "") + c.city_name + (c.ward_name ?? ""))[0],
});

export const toPref = (p: PrefTableRow): PrefRow => ({
  lgCode: p.lg_code,
  prefCode: p.pref_code,
  prefName: p.pref_name,
});
