// abrg/internal/matching/basic_detect.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit } from "../char/char";
import { All, type MatchedResult } from "../model/model";
import { IsSenGoPattern } from "../transform/hokkaido";
import { StandardizeSpecialChars } from "../transform/special_chars";
import { TextForBasicNormalized } from "../transform/text";
import { lookupCityPrefix } from "./city_prefix";
import { detectPrefectureCode, removePrefectureFromAddress } from "./detect_prefecture";
import { detectMachiaza } from "./detect_machiaza";
import type { Impl } from "./matcher";
import { cut } from "./unmatched/unmatched";

/** 頭の都道府県を外す。都道府県が無ければ市区町村名から都道府県を推す (京都市下京区… → 26) */
const detectAndRemovePrefecture = (n: Impl, searchAddr: string, pref: string): [string, string] => {
  const needs = pref === All || pref === "";
  const code = detectPrefectureCode(searchAddr);
  if (code !== "") return [removePrefectureFromAddress(searchAddr, code), needs ? code : pref];
  if (needs) {
    const fromCity = lookupCityPrefix(n.cityPrefixMap, searchAddr);
    if (fromCity !== "") return [searchAddr, fromCity];
  }
  return [searchAddr, pref];
};

const selectSearchAddr = (withColon: string, modified: string, hasColon: boolean): string => {
  if (modified === "" || (!modified.includes(":") && !modified.includes("@"))) return withColon;
  if (!hasColon || IsSenGoPattern(modified)) return modified;
  return withColon;
};

/** 市区町村+区 から lg_code を引く (あいまい一致の範囲を 1 市区町村に絞るため) */
export const detectLgCode = (n: Impl, searchAddr: string): string => {
  const end = n.cityBoundary.find(searchAddr);
  if (end <= 0) return "";
  return n.cityWardLgCodes.get(searchAddr.slice(0, end)) ?? "";
};

/**
 * 都道府県を外し、":" で町名と番号を分けてから町字を探す。
 * 返すのは [都道府県コード, 検索文字, 町字の候補]
 */
export const detectBasicResultsWithBasic = async (
  n: Impl,
  normalizedAddr: string,
  prefIn: string,
): Promise<[string, string, MatchedResult[]]> => {
  const [first] = cut(normalizedAddr, " ");
  const [special] = StandardizeSpecialChars(first);
  // 漢数字を直す前に外す (三重県 が 3重県 にならないように)
  const [searchAddr, pref] = detectAndRemovePrefecture(n, special, prefIn);
  const [withColon] = TextForBasicNormalized(searchAddr);
  const [base, afterColon, hasColon] = cut(withColon, ":");

  const [results, modified] = await detectMachiaza(n.repo, base, pref, normalizedAddr);
  if (results.length > 0) return [pref, selectSearchAddr(withColon, modified, hasColon), results];

  // 番号の頭が数字なら、丁目まで含めて探し直す
  if (hasColon && afterColon !== "" && IsASCIIDigit(afterColon[0])) {
    const [r, m] = await detectMachiaza(n.repo, withColon, pref, normalizedAddr);
    if (r.length > 0) return [pref, m !== "" && m.includes("@") ? m : withColon, r];
  }
  return [pref, withColon, []];
};
