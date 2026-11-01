// abrg/internal/matching/levenshtein/result.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit } from "../../char/char";
import { DetermineMatchLevel, FormatAddress, type MatchedResult } from "../../model/model";
import { BasicResultToPartialNormalized, type BasicResult } from "../../repository/types";
import { ExtractTrailingAddressNumbers } from "../../util/address";
import { cut, trimSuffix } from "../unmatched/unmatched";
import { SelectBestByJaccard } from "./jaccard";
import { hasChomeMismatch } from "./mismatch";
import { runeLevenshteinFrom } from "./rune_levenshtein";
import { calculateEditDistanceScore } from "./score";
import { extractUnmatchedAddress } from "./unmatched";

/** 検索文字の番号の部分 (":" の後ろ、無ければ末尾の数字とハイフン) */
export const ExtractSearchNumbers = (searchAddr: string): string => {
  const [, after, found] = cut(searchAddr, ":");
  if (found) return after;
  if (searchAddr === "") return "";
  return ExtractTrailingAddressNumbers(trimSuffix(searchAddr, "号"));
};

/** 番号の無い入力に、丁目まである候補 ("@") を返さない */
const shouldSkipBasicCategory = (
  category: string,
  searchAddr: string,
  searchNumbers: string,
  std: string,
) => category === "basic" && !searchAddr.includes("@") && searchNumbers === "" && std.includes("@");

/** 入力が数字で終わり、候補がその後に数字の無い名前を続けるもの (小字の途中で止まった入力) */
const isPartialKoazaMatch = (searchAddr: string, std: string): boolean => {
  if (std.length <= searchAddr.length || !std.startsWith(searchAddr)) return false;
  if (searchAddr === "" || !IsASCIIDigit(searchAddr[searchAddr.length - 1])) return false;
  return !Array.from(std.slice(searchAddr.length)).some(IsASCIIDigit);
};

/** 候補の丁目 ("大塚1@") の前の町名の後に、入力が数字でない文字を続けるもの (地名で、丁目ではない) */
const isFalseChomeMatch = (searchAddr: string, std: string): boolean => {
  if (!std.includes("@") || searchAddr.includes("@")) return false;
  const atIdx = std.indexOf("@");
  if (atIdx <= 0) return false;
  let oazaEnd = atIdx;
  while (oazaEnd > 0 && IsASCIIDigit(std[oazaEnd - 1])) oazaEnd--;
  if (oazaEnd === atIdx) return false;
  const oaza = std.slice(0, oazaEnd);
  const [searchBase] = cut(searchAddr, ":");
  if (!searchBase.startsWith(oaza)) return false;
  const extra = searchBase.slice(oaza.length);
  return extra !== "" && !Array.from(extra).every(IsASCIIDigit);
};

const selectBySearchNumbers = (
  results: MatchedResult[],
  searchNumbers: string,
): MatchedResult | null => {
  if (searchNumbers === "" || results.length === 0) return null;
  const score = ({ structured_address: { oaza_cho, koaza } }: MatchedResult): number => {
    const oaza = oaza_cho !== null && oaza_cho.includes(searchNumbers) ? 1 : 0;
    if (koaza === null || !koaza.includes(searchNumbers)) return oaza;
    return koaza.startsWith(searchNumbers) ? 3 : Math.max(oaza, 2);
  };
  return results.reduce((best, r) => (score(r) > score(best) ? r : best), results[0]);
};

const selectBestFromTiedResults = (
  results: MatchedResult[],
  searchNumbers: string,
  originalAddr: string,
): MatchedResult[] => {
  if (results.length <= 1) return results;
  let n = 1;
  while (n < results.length && results[n].score === results[0].score) n++;
  if (n <= 1) return results;
  const tied = results.slice(0, n);
  if (searchNumbers !== "") {
    const selected = selectBySearchNumbers(tied, searchNumbers);
    return selected ? [selected, ...results.slice(n)] : results;
  }
  if (originalAddr !== "") return [...SelectBestByJaccard(tied, originalAddr), ...results.slice(n)];
  return results;
};

/** あいまい一致の候補を絞り、点を付けて並べる */
export const processResults = (
  candidates: BasicResult[],
  searchAddr: string,
  searchNumbers: string,
  normalizedAddr: string,
  category: string,
  limit: number,
): MatchedResult[] => {
  const searchRunes = Array.from(searchAddr);
  const results = candidates
    .filter(
      (brd) =>
        !hasChomeMismatch(searchAddr, brd.chome) &&
        !shouldSkipBasicCategory(category, searchAddr, searchNumbers, brd.normalizedAddress) &&
        !isPartialKoazaMatch(searchAddr, brd.normalizedAddress) &&
        !isFalseChomeMatch(searchAddr, brd.normalizedAddress),
    )
    .map((brd): MatchedResult => {
      const r = BasicResultToPartialNormalized(brd);
      const matched = FormatAddress(r.structured_address);
      return {
        ...r,
        matched_address: matched,
        unmatched_address: extractUnmatchedAddress(
          searchNumbers,
          r.structured_address,
          category,
          searchAddr,
          normalizedAddr,
          matched,
        ),
        match_level: DetermineMatchLevel(r.ids),
        score: calculateEditDistanceScore(
          runeLevenshteinFrom(searchRunes, brd.normalizedAddress),
          searchRunes.length,
        ),
      };
    });
  // Go の slices.SortFunc は安定でないが、同点は後で選び直すので並びの差は結果に出にくい
  results.sort((a, b) => b.score - a.score);
  return selectBestFromTiedResults(results, searchNumbers, normalizedAddr).slice(0, limit);
};
