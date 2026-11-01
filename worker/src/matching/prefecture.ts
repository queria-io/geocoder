// abrg/internal/matching/prefecture.go の写し (upstream/UPSTREAM のコミット)
import {
  emptyIDs,
  emptyMachiaza,
  emptySA,
  FormatAddress,
  type MatchedResult,
} from "../model/model";
import { byteLength } from "../repository/editdist";
import type { CityResult } from "../repository/types";
import { MaxEditDistance } from "../util/address";
import { NormalizeUnmatchedNumbers } from "./levenshtein/unmatched";
import type { Impl } from "./matcher";
import { cutPrefix, SplitStandardizedAddress, trimPrefix } from "./unmatched/unmatched";

/** 都道府県だけ当たった結果 (点 0.1) */
export const queryPrefectureRecord = async (
  n: Impl,
  prefCode: string,
  normalizedAddr: string,
): Promise<MatchedResult | null> => {
  const pr = await n.repo.FindPrefecture(prefCode);
  if (pr === null) return null;
  const [addressPart, buildingParts] = SplitStandardizedAddress(normalizedAddr);
  const [rest] = cutPrefix(addressPart, pr.prefName);
  return {
    matched_address: pr.prefName,
    unmatched_address: [...(rest !== "" ? [rest] : []), ...buildingParts],
    match_level: "pref",
    score: 0.1,
    ids: { ...emptyIDs(), lg_code: pr.lgCode },
    structured_address: { ...emptySA(), pref: pr.prefName },
    coordinates: null,
    machiaza: emptyMachiaza(),
  };
};

const extractCityUnmatched = (
  matchedAddr: string,
  pref: string,
  searchAddr: string,
  normalizedAddr: string,
  cityEnd: number,
): string[] => {
  const [addressPart, buildingParts] = SplitStandardizedAddress(normalizedAddr);
  const [a1, f1] = cutPrefix(addressPart, matchedAddr);
  const [a2, f2] = cutPrefix(addressPart, trimPrefix(matchedAddr, pref));
  const rest =
    f1 && a1 !== ""
      ? a1
      : f2 && a2 !== ""
        ? a2
        : cityEnd < searchAddr.length
          ? searchAddr.slice(cityEnd).replaceAll(":", "")
          : "";
  return [...(rest !== "" ? [NormalizeUnmatchedNumbers(rest)] : []), ...buildingParts];
};

/** 市区町村だけ当たった結果 (点 0.3) */
const buildCityResult = (
  cr: CityResult,
  searchAddr: string,
  normalizedAddr: string,
  cityEnd: number,
): MatchedResult => {
  const sa = { ...emptySA(), pref: cr.pref, county: cr.county, city: cr.city, ward: cr.ward };
  const matched = FormatAddress(sa);
  const unmatched = extractCityUnmatched(matched, cr.pref, searchAddr, normalizedAddr, cityEnd);
  return {
    matched_address: matched,
    unmatched_address: unmatched.length > 0 ? unmatched : null,
    match_level: "city",
    score: 0.3,
    ids: { ...emptyIDs(), lg_code: cr.lgCode },
    structured_address: sa,
    coordinates: null,
    machiaza: emptyMachiaza(),
  };
};

export const queryCityRecord = async (
  n: Impl,
  searchAddr: string,
  prefCode: string,
  normalizedAddr: string,
): Promise<MatchedResult | null> => {
  const cityEnd = n.cityBoundary.find(searchAddr);
  if (cityEnd <= 0) return null;
  const cr = await n.repo.FindCityRecord({ cityPart: searchAddr.slice(0, cityEnd), prefCode });
  return cr === null ? null : buildCityResult(cr, searchAddr, normalizedAddr, cityEnd);
};

/** 伏せ字や誤字 ("●橋市") の市区町村を編集距離で探す。都道府県が分かっているときだけ */
export const queryCityRecordFuzzy = async (
  n: Impl,
  searchAddr: string,
  prefCode: string,
  normalizedAddr: string,
): Promise<MatchedResult | null> => {
  if (prefCode === "" || prefCode === "all") return null;
  const cityEnd = n.cityBoundary.find(searchAddr);
  if (cityEnd <= 0) return null;
  const cityPart = searchAddr.slice(0, cityEnd);
  const cr = await n.repo.FindCityRecordFuzzy({
    cityPart,
    prefCode,
    maxEditDistance: MaxEditDistance(byteLength(cityPart)),
  });
  return cr === null ? null : buildCityResult(cr, searchAddr, normalizedAddr, cityEnd);
};
