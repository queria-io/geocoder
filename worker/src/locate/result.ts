// 市区町村まで決まった答えの町字・番号・座標を、照合の索引 (locate) で引き直す
import {
  type CoordinateLevel,
  DetermineMatchLevel,
  Detail,
  emptySA,
  FormatAddress,
  type MatchedResult,
} from "../model/model";
import type { BasicResult, CityResult } from "../repository/types";
import { cityIndex, type CityIndex, type MatchAreaRow, numbersOf } from "./index";
import { candidates, EMPTY_NUMBERS, locate, type Located, type Numbers, remainder } from "./locate";
import { CHOME } from "./norm";
import type { ParcelRow } from "../repository/parcel";
import type { RsdtdspRow } from "../repository/rsdtdsp";
import type { MatchNumberRow } from "./index";

export type LocateDeps = {
  areas: (lgCode: string) => Promise<MatchAreaRow[]>;
  numbers: (areaId: number) => Promise<MatchNumberRow[]>;
  rsdt: (lgCode: string, machiazaId: string) => Promise<RsdtdspRow[]>;
  parcels: (lgCode: string, machiazaId: string) => Promise<ParcelRow[]>;
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>;
  city: (lgCode: string) => CityResult | undefined;
};

/** 点の優先順 (rank) ごとの、座標を取った点の段 */
const LEVEL: Record<number, CoordinateLevel> = {
  1: "parcel",
  2: "rsdtdsp_rsdt",
  3: "parcel_parent",
  4: "parcel_parent",
  5: "rsdtdsp_blk",
  6: "rsdtdsp_blk",
  7: "parcel_parent",
};

// 表のバージョンが変わると forward.ts が deps を作り直す。area_id はビルドごとに振り直すので、
// 市区町村の索引は deps ごとに覚える (isolate 全体で覚えると古い area_id で match_number を引く)
const indexCache = new WeakMap<LocateDeps, Map<string, Promise<CityIndex>>>();

const cityIndexOf = (deps: LocateDeps, lgCode: string): Promise<CityIndex> => {
  const indexes = indexCache.get(deps) ?? new Map<string, Promise<CityIndex>>();
  indexCache.set(deps, indexes);
  const hit = indexes.get(lgCode);
  if (hit) return hit;
  const p = deps.areas(lgCode).then(cityIndex);
  if (indexes.size >= 256) indexes.delete(indexes.keys().next().value as string);
  indexes.set(lgCode, p);
  p.catch(() => indexes.delete(lgCode));
  return p;
};

/** 区域の名前 k の番号を読む (区域の行の番号ごとの match_number と、町字ごとの rsdtdsp・parcel) */
const loadNumbers = async (
  deps: LocateDeps,
  index: CityIndex,
  lgCode: string,
  k: string,
): Promise<Numbers> => {
  const mids = index.machiazaIds.get(k) ?? [];
  const ids = index.areaIds.get(k) ?? [];
  const [rsdt, parcel, numbers] = await Promise.all([
    Promise.all(mids.map((m) => deps.rsdt(lgCode, m))).then((x) => x.flat()),
    Promise.all(mids.map((m) => deps.parcels(lgCode, m))).then((x) => x.flat()),
    Promise.all(ids.map((id) => deps.numbers(id))).then((x) => x.flat()),
  ]);
  return numbersOf({ rsdt, parcel, numbers });
};

const toResult = async (
  r: MatchedResult,
  found: Located,
  deps: LocateDeps,
  lgCode: string,
  whole: string,
): Promise<MatchedResult> => {
  const town = found.machiazaId === null ? null : await deps.town(lgCode, found.machiazaId);
  // 町字が決まらなければ (位置参照情報にだけある区域など)、住所の表記は市区町村までにし、
  // 番号も表記と ID に載せない。区域の名前を落として番号だけを市区町村名に続けないため
  const n = town === null ? null : found.number;
  const fromRsdt = n?.ids?.blk_id !== undefined;
  const fromParcel = n?.ids?.prc_id !== undefined;
  const residential = n?.pointType === "rsdt" || n?.pointType === "block";
  const ids = {
    ...r.ids,
    machiaza_id: town?.machiazaId ?? null,
    rsdt_addr_flg: town?.rsdtAddrFlg ?? null,
    blk_id: n?.ids?.blk_id ?? null,
    rsdt_id: n?.ids?.rsdt_id ?? null,
    rsdt2_id: n?.ids?.rsdt2_id ?? null,
    prc_id: n?.ids?.prc_id ?? null,
  };
  const parts = n?.parts ?? [];
  const sa = {
    ...r.structured_address,
    kyoto_st: town?.kyotoSt ?? null,
    oaza_cho: town?.oazaCho ?? null,
    chome: town?.chome ?? null,
    koaza: town?.koaza ?? null,
    machiaza_dist: town?.machiazaDist ?? null,
    blk_num: residential ? (parts[0] ?? null) : null,
    rsdt_num: residential ? (parts[1] ?? null) : null,
    rsdt_num2: residential ? (parts[2] ?? null) : null,
    prc_num1: residential ? null : (parts[0] ?? null),
    prc_num2: residential ? null : (parts[1] ?? null),
    prc_num3: residential ? null : (parts[2] ?? null),
  };
  const level = DetermineMatchLevel(ids);
  const rest = (town === null ? whole : found.rest).replace(/^-+|-+$/g, "");
  const point = found.number;
  return {
    ...r,
    matched_address: FormatAddress(sa),
    unmatched_address: rest === "" ? null : [rest],
    match_level: level,
    ids,
    structured_address: sa,
    coordinates: [found.point[0], found.point[1]],
    ...(point === null || fromRsdt || fromParcel
      ? { coordinate_level: undefined, coordinate_source: undefined }
      : {
          coordinate_level: LEVEL[point.rank] ?? "parcel_parent",
          coordinate_source: point.source,
        }),
  };
};

/** 市区町村の点だけを返す (町字に当たらなかったとき) */
const atCity = (r: MatchedResult, city: CityResult | undefined, rest: string): MatchedResult => {
  const ids = {
    ...r.ids,
    machiaza_id: null,
    rsdt_addr_flg: null,
    blk_id: null,
    rsdt_id: null,
    rsdt2_id: null,
    prc_id: null,
  };
  const sa = {
    ...emptySA(),
    pref: r.structured_address.pref,
    county: r.structured_address.county,
    city: r.structured_address.city,
    ward: r.structured_address.ward,
  };
  return {
    ...r,
    matched_address: FormatAddress(sa),
    unmatched_address: rest === "" ? null : [rest],
    match_level: DetermineMatchLevel(ids),
    ids,
    structured_address: sa,
    coordinates: city?.lon != null && city.lat != null ? [city.lon, city.lat] : null,
    coordinate_level: "city",
    coordinate_source: undefined,
  };
};

/**
 * 市区町村まで決まった答え r の、町字から先を住所 address から引き直す。
 * 区域に当たらなければ市区町村の点を返す。住所の書き方から 1 つに決められない番号 (甲乙丙丁の違いだけ) は、
 * 候補をすべて返し、candidates にその数を入れる
 */
export const withLocated = async (
  r: MatchedResult,
  address: string,
  deps: LocateDeps,
): Promise<MatchedResult[]> => {
  const lgCode = r.ids.lg_code;
  if (!lgCode || Detail(r.match_level) < Detail("city")) return [r];
  const city = deps.city(lgCode);
  if (!city) return [r];
  const index = await cityIndexOf(deps, lgCode);
  const rest = remainder(address, city);
  const keys = candidates(rest, index.areas);
  const loaded = new Map(
    await Promise.all(
      keys.map(async (k) => [k, await loadNumbers(deps, index, lgCode, k)] as const),
    ),
  );
  const found = locate(rest, index.areas, (k) => loaded.get(k) ?? EMPTY_NUMBERS);
  // 照合できなかった部分には丁目の印を残さない
  const plain = rest.replaceAll(CHOME, "-");
  if (found === null) return [atCity(r, city, plain.replace(/^-+|-+$/g, ""))];
  const all = [found, ...(found.others ?? [])];
  const results = await Promise.all(all.map((f) => toResult(r, f, deps, lgCode, plain)));
  return all.length > 1
    ? results.map((x) => ({ ...x, candidates: (r.candidates ?? 1) * all.length }))
    : results;
};
