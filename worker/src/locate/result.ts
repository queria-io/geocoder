// 市区町村まで決まった答えの町字・番号・座標を、照合の索引 (locate) で引き直す
import {
  type CoordinateLevel,
  DetermineMatchLevel,
  Detail,
  emptySA,
  FormatAddress,
  IsBaseMachiazaID,
  type MatchedResult,
} from "../model/model";
import type { BasicResult, CityResult } from "../repository/types";
import { type CityIndex, numbersOf } from "./index";
import { candidates, EMPTY_NUMBERS, locate, type Located, type Numbers, remainder } from "./locate";
import { CHOME } from "./norm";
import { cityPoint, keptSteps, locateSteps, pointOf, prefPoint } from "../evidence";
import type { PrefRow } from "../repository/memory";
import type { ParcelRow } from "../repository/parcel";
import type { RsdtdspRow } from "../repository/rsdtdsp";
import type { MatchNumberRow } from "./index";

export type LocateDeps = {
  /** 市区町村 1 つ分の区域の索引 */
  index: (lgCode: string) => Promise<CityIndex>;
  /** 区域の番号ごとの点 (match_number)。渡した区域の行をまとめて読む */
  numbers: (lgCode: string, areaIds: readonly number[]) => Promise<MatchNumberRow[]>;
  /** 町字の住居表示・地番の行。渡した町字の行をまとめて読む */
  rsdt: (lgCode: string, machiazaIds: readonly string[]) => Promise<RsdtdspRow[]>;
  parcels: (lgCode: string, machiazaIds: readonly string[]) => Promise<ParcelRow[]>;
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>;
  city: (lgCode: string) => CityResult | undefined;
  /**
   * 照合した結果を問い合わせの中で使い回す口 (市区町村と住所の残りの組ごと)。市区町村名の無い住所は、
   * 再照合と座標を引く段で同じ住所を 2 回引くため
   */
  memo?: Map<string, Promise<Located | null>>;
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

/**
 * 区域の名前 keys の番号を読む (区域の行の番号ごとの match_number と、町字ごとの rsdtdsp・parcel)。
 * 区域の名前が違っても町字の行は同じ行グループに入ることが多いので、全部の名前の分を 1 回で読んでから分ける
 */
const loadNumbers = async (
  deps: LocateDeps,
  index: CityIndex,
  lgCode: string,
  keys: readonly string[],
): Promise<Map<string, Numbers>> => {
  const mids = keys.flatMap((k) => index.machiazaIds.get(k) ?? []);
  const ids = keys.flatMap((k) => index.areaIds.get(k) ?? []);
  const [rsdt, parcel, numbers] = await Promise.all([
    deps.rsdt(lgCode, mids),
    deps.parcels(lgCode, mids),
    deps.numbers(lgCode, ids),
  ]);
  return new Map(
    keys.map((k) => {
      const m = new Set(index.machiazaIds.get(k) ?? []);
      const a = new Set(index.areaIds.get(k) ?? []);
      return [
        k,
        numbersOf({
          rsdt: rsdt.filter((r) => m.has(r.machiaza_id)),
          parcel: parcel.filter((r) => m.has(r.machiaza_id)),
          numbers: numbers.filter((r) => a.has(Number(r.area_id))),
        }),
      ];
    }),
  );
};

type Town = Pick<
  BasicResult,
  "machiazaId" | "oazaCho" | "chome" | "koaza" | "kyotoSt" | "machiazaDist" | "rsdtAddrFlg"
>;

/** 丁目を省いた大字・町の町字。ABR に行が無いので、区域の名前と町字 ID だけを持つ */
const oazaOnly = (machiazaId: string, name: string): Town => ({
  machiazaId,
  oazaCho: name,
  chome: null,
  koaza: null,
  kyotoSt: null,
  machiazaDist: null,
  rsdtAddrFlg: null,
});

const toResult = async (
  r: MatchedResult,
  found: Located,
  deps: LocateDeps,
  lgCode: string,
  whole: string,
  /** 照合した区域の名前 (照合の索引の表記) */
  areaName: string | null,
): Promise<MatchedResult> => {
  const row = found.machiazaId === null ? null : await deps.town(lgCode, found.machiazaId);
  // 丁目を省いた大字・町の区域 (「学園南」) は ABR に町字の行が無い。町字 ID が大字・町 (末尾 000) で
  // 番号を読まなかったときだけ、区域の名前を大字・町の名前にする
  const town: Town | null =
    row ??
    (found.machiazaId !== null &&
    IsBaseMachiazaID(found.machiazaId) &&
    found.number === null &&
    areaName !== null
      ? oazaOnly(found.machiazaId, areaName)
      : null);
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
    steps: [...keptSteps(r.steps), ...locateSteps(found)],
    evidence_point: pointOf(found, lgCode, town === null ? null : found.machiazaId),
    evidence_matched: {
      area: areaName,
      // 座標は町字が決まらなくても番号の点から取るので、照合した番号は point の鍵とそろえる
      number: found.number === null ? null : found.number.parts.join("-"),
      skipped: found.via.skipped === "" ? null : found.via.skipped,
    },
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
    steps: keptSteps(r.steps),
    evidence_point: city?.lon != null && city.lat != null ? cityPoint(city.lgCode) : null,
    evidence_matched: { area: null, number: null, skipped: null },
  };
};

/** 都道府県だけ当たった答えに、都道府県の代表点を付ける */
export const atPref = (r: MatchedResult, pref: PrefRow | undefined): MatchedResult =>
  r.match_level !== "pref" || r.coordinates !== null || pref?.lon == null || pref.lat == null
    ? r
    : {
        ...r,
        coordinates: [pref.lon, pref.lat],
        coordinate_level: "pref",
        evidence_point: prefPoint(pref.lgCode),
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
  const index = await deps.index(lgCode);
  const rest = remainder(address, city);
  const run = async () => {
    const keys = candidates(rest, index.areas);
    const loaded = await loadNumbers(deps, index, lgCode, keys);
    return locate(rest, index.areas, (k) => loaded.get(k) ?? EMPTY_NUMBERS);
  };
  const key = `${lgCode}\t${rest}`;
  const kept = deps.memo?.get(key) ?? run();
  deps.memo?.set(key, kept);
  const found = await kept;
  // 照合できなかった部分には丁目の印を残さない
  const plain = rest.replaceAll(CHOME, "-");
  if (found === null) return [atCity(r, city, plain.replace(/^-+|-+$/g, ""))];
  const all = [found, ...(found.others ?? [])];
  const results = await Promise.all(
    all.map((f) => toResult(r, f, deps, lgCode, plain, index.areas.get(f.area)?.name ?? null)),
  );
  return all.length > 1
    ? results.map((x) => ({ ...x, candidates: (r.candidates ?? 1) * all.length }))
    : results;
};
