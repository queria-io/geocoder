// abrg/internal/repository の型と変換の写し (upstream/UPSTREAM のコミット)。町字までの分だけ
import {
  DetermineMatchLevel,
  emptyIDs,
  emptyMachiaza,
  emptySA,
  FormatAddress,
  type IDs,
  type MachiazaData,
  type MatchedResult,
  type Str,
  type StructuredAddress,
} from "../model/model";
import type { ParcelFilter, ParcelRow } from "./parcel";
import type { ResidentialBestResult, ResidentialFilter } from "./rsdtdsp";

/** 町字の 1 行。normalizedAddress は 郡・市区町村・区・通り名・大字町・丁目・小字 を TextForDB に通したもの */
export type BasicResult = {
  normalizedAddress: string;
  lgCode: string;
  machiazaId: string;
  rsdtAddrFlg: Str;
  pref: string;
  county: Str;
  city: string;
  ward: Str;
  kyotoSt: Str;
  oazaCho: Str;
  chome: Str;
  koaza: Str;
  machiazaDist: Str;
  hasChome: boolean;
  parcelCount: number;
  rsdtdspCount: number;
  /** 町字の郵便番号。上流には無い */
  postCode?: string | null;
  /** 地番が振られた区域の町字 ID と、その区域で地番が一意か。上流には無い */
  numberingId?: string | null;
  parcelUnique?: boolean;
  lon: number | null;
  lat: number | null;
};

export type CityResult = {
  lgCode: string;
  pref: string;
  county: Str;
  city: string;
  ward: Str;
  lon: number | null;
  lat: number | null;
};

export type PrefectureResult = { lgCode: string; prefName: string };

export type CityRecordParams = { cityPart: string; prefCode: string };
export type CityFuzzyParams = { cityPart: string; prefCode: string; maxEditDistance: number };
export type BasicSearchParams = { address: string; prefCode: string; limit: number };
export type LevenshteinParams = {
  searchAddr: string;
  prefCode: string;
  lgCode: string;
  machiazaId: string;
  lgCodes: string[];
  limit: number;
};
export type PrefixParams = { baseAddr: string; prefCode: string; limit: number };
export type CitySearchParams = { cityAddr: string; lgCode: string; prefCode: string };

/** 当て方が読む表。上流は DuckDB の SQL、こちらは町字の行を持つ実装 (repository/memory.ts) に差し替える */
export type Repository = {
  FindCityRecord: (p: CityRecordParams) => Promise<CityResult | null>;
  FindCityRecordFuzzy: (p: CityFuzzyParams) => Promise<CityResult | null>;
  FindCandidateLgCodes: (p: CityFuzzyParams) => Promise<string[]>;
  FindPrefecture: (prefCode: string) => Promise<PrefectureResult | null>;
  FindBasicByAddress: (p: BasicSearchParams) => Promise<BasicResult[]>;
  FindBasicByLevenshtein: (p: LevenshteinParams) => Promise<BasicResult[]>;
  FindBasicByPrefix: (p: PrefixParams) => Promise<BasicResult[]>;
  FindCityByAddress: (p: CitySearchParams) => Promise<CityResult | null>;
  FindResidentialBestMatch: (
    lgCode: string,
    machiazaId: string,
    filter: ResidentialFilter,
  ) => Promise<ResidentialBestResult | null>;
  FindParcelExact: (
    lgCode: string,
    machiazaId: string,
    filter: ParcelFilter,
  ) => Promise<ParcelRow | null>;
};

const coords = (lon: number | null, lat: number | null): [number, number] | null =>
  lon !== null && lat !== null ? [lon, lat] : null;

const basicSA = (br: BasicResult): StructuredAddress => ({
  ...emptySA(),
  pref: br.pref,
  county: br.county,
  city: br.city,
  ward: br.ward,
  kyoto_st: br.kyotoSt,
  oaza_cho: br.oazaCho,
  chome: br.chome,
  koaza: br.koaza,
  machiaza_dist: br.machiazaDist,
});

export const BuildIDs = (lgCode: string, machiazaId: string, rsdtAddrFlg: Str): IDs => ({
  ...emptyIDs(),
  rsdt_addr_flg: rsdtAddrFlg,
  lg_code: lgCode.length === 6 ? lgCode : null,
  machiaza_id: machiazaId.length === 7 ? machiazaId : null,
});

const basicMachiaza = (br: BasicResult): MachiazaData => ({
  ...emptyMachiaza(),
  hasChome: br.hasChome,
  parcelCount: br.parcelCount,
  rsdtdspCount: br.rsdtdspCount,
});

export const BasicResultToPartialNormalized = (br: BasicResult): MatchedResult => ({
  matched_address: "",
  unmatched_address: null,
  match_level: "unknown",
  score: 0,
  ids: BuildIDs(br.lgCode, br.machiazaId, br.rsdtAddrFlg),
  structured_address: basicSA(br),
  coordinates: coords(br.lon, br.lat),
  machiaza: basicMachiaza(br),
});

export const BasicResultToNormalized = (br: BasicResult): MatchedResult => {
  const r = BasicResultToPartialNormalized(br);
  return {
    ...r,
    matched_address: FormatAddress(r.structured_address),
    match_level: DetermineMatchLevel(r.ids),
    score: 1,
  };
};
