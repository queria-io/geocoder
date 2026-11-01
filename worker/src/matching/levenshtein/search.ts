// abrg/internal/matching/levenshtein/search.go と params.go の写し (upstream/UPSTREAM のコミット)
import {
  All,
  DetermineMatchLevel,
  emptyIDs,
  emptySA,
  FormatAddress,
  type Category,
  type MatchedResult,
} from "../../model/model";
import { byteLength } from "../../repository/editdist";
import { BasicResultToPartialNormalized, type Repository } from "../../repository/types";
import { MaxEditDistance } from "../../util/address";
import type { CityBoundary } from "../../util/city_boundary";
import { cut, cutPrefix, trimPrefix } from "../unmatched/unmatched";
import { hasTownNameMismatch } from "./mismatch";
import { ExtractSearchNumbers, processResults } from "./result";
import { extractUnmatchedSegments } from "./unmatched";

export type SearchParams = {
  Category: Category;
  SearchAddr: string;
  Pref: string;
  LgCode: string;
  MachiazaID: string;
  NormalizedAddr: string;
  Limit: number;
  CityBoundary: CityBoundary;
};

const minPrefixMatchLength = 5;

const hasRegionAnchor = (p: SearchParams): boolean =>
  p.LgCode !== "" || (p.Pref !== "" && p.Pref !== All);

const cityPart = (p: SearchParams): string => {
  const end = p.CityBoundary.find(p.SearchAddr);
  return end <= 0 ? "" : p.SearchAddr.slice(0, end);
};

const candidateLgCodes = async (repo: Repository, p: SearchParams): Promise<string[]> => {
  const part = cityPart(p);
  if (part === "") return [];
  return repo.FindCandidateLgCodes({
    cityPart: part,
    prefCode: p.Pref,
    maxEditDistance: MaxEditDistance(byteLength(part)),
  });
};

const searchCore = async (repo: Repository, p: SearchParams): Promise<MatchedResult[]> => {
  if (p.Category !== "basic")
    throw new Error(`unsupported category for Levenshtein search: ${p.Category}`);
  const lgCodes = hasRegionAnchor(p) ? [] : await candidateLgCodes(repo, p);
  if (!hasRegionAnchor(p) && lgCodes.length === 0) return [];
  const rows = await repo.FindBasicByLevenshtein({
    searchAddr: p.SearchAddr,
    prefCode: p.Pref,
    lgCode: p.LgCode,
    machiazaId: p.MachiazaID,
    lgCodes,
    limit: p.Limit,
  });
  return processResults(
    rows,
    p.SearchAddr,
    ExtractSearchNumbers(p.SearchAddr),
    p.NormalizedAddr,
    p.Category,
    p.Limit,
  );
};

/** 町字の名前が入力の頭にそのまま含まれる候補を、長いものから。点は一致した長さの割合 */
const searchWithPrefixMatch = async (
  repo: Repository,
  p: SearchParams,
): Promise<MatchedResult[]> => {
  const baseAddr = cut(cut(p.SearchAddr, ":")[0], "@")[0];
  const baseLen = Array.from(baseAddr).length;
  if (baseLen < minPrefixMatchLength) return [];
  const candidates = await repo.FindBasicByPrefix({ baseAddr, prefCode: p.Pref, limit: p.Limit });
  return candidates.map((brd) => {
    const r = BasicResultToPartialNormalized(brd);
    const matched = FormatAddress(r.structured_address);
    return {
      ...r,
      matched_address: matched,
      unmatched_address: extractUnmatchedSegments(p.NormalizedAddr, matched),
      match_level: DetermineMatchLevel(r.ids),
      score: Array.from(brd.normalizedAddress).length / baseLen,
    };
  });
};

const standardizedRemainder = (
  std: string,
  matched: string,
  pref: string,
  boundary: CityBoundary,
): string => {
  const [rest, ok] = cutPrefix(std, matched);
  if (ok) return rest;
  const [rest2, ok2] = cutPrefix(std, trimPrefix(matched, pref));
  if (ok2) return rest2;
  return std.slice(boundary.find(std));
};

/** 町字が見つからないとき、市区町村だけで返す (点 0.3) */
const tryFallbackCitySearchByScore = async (
  repo: Repository,
  p: SearchParams,
): Promise<MatchedResult[]> => {
  const end = p.CityBoundary.find(p.SearchAddr);
  if (end <= 0) return [];
  const cr = await repo.FindCityByAddress({
    cityAddr: p.SearchAddr.slice(0, end),
    lgCode: p.LgCode,
    prefCode: p.Pref,
  });
  if (cr === null) return [];
  const sa = { ...emptySA(), pref: cr.pref, county: cr.county, city: cr.city, ward: cr.ward };
  const matched = FormatAddress(sa);
  const parts = standardizedRemainder(p.NormalizedAddr, matched, cr.pref, p.CityBoundary)
    .split(/\s+/)
    .filter((s) => s !== "");
  return [
    {
      matched_address: matched,
      unmatched_address: parts.length > 0 ? parts : null,
      match_level: "city",
      score: 0.3,
      ids: { ...emptyIDs(), lg_code: cr.lgCode },
      structured_address: sa,
      coordinates: cr.lon !== null && cr.lat !== null ? [cr.lon, cr.lat] : null,
      machiaza: { hasChome: false, parcelCount: 0, rsdtdspCount: 0 },
    },
  ];
};

/** 編集距離で町字を探す。町名が入力と別物なら、頭の一致、市区町村の順に引き下げる */
export const Search = async (repo: Repository, p: SearchParams): Promise<MatchedResult[]> => {
  const results = await searchCore(repo, p);
  if (results.length > 0 && hasTownNameMismatch(p.CityBoundary, p.SearchAddr, results[0])) {
    const prefix = await searchWithPrefixMatch(repo, p);
    if (
      prefix.length > 0 &&
      prefix[0].structured_address.oaza_cho !== null &&
      !hasTownNameMismatch(p.CityBoundary, p.SearchAddr, prefix[0])
    )
      return prefix;
    return tryFallbackCitySearchByScore(repo, p);
  }
  if (results.length === 0) {
    const prefix = await searchWithPrefixMatch(repo, p);
    if (prefix.length > 0) return prefix;
  }
  return results;
};
