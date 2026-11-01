// abrg/internal/matching/unmatched.go の写し (upstream/UPSTREAM のコミット)
import type { MatchedResult, StructuredAddress } from "../model/model";
import { ExtractSearchNumbers } from "./levenshtein/result";
import { IsSearchNumbersPartOfPlaceName } from "./levenshtein/unmatched";
import type { ParsedAddress } from "./parsed_addr";
import { ExtractUnmatchedParts, trimPrefix } from "./unmatched/unmatched";

/** 当たった町字の後ろの残りを入れる。番号が小字の名前の一部なら、残りは無い (「番」を書いた入力は除く) */
export const setUnmatchedAddress = (
  result: MatchedResult,
  normalizedAddr: string,
  adjustedSearchAddr: string,
): MatchedResult => {
  const nums = ExtractSearchNumbers(adjustedSearchAddr);
  if (
    nums !== "" &&
    result.structured_address.chome === null &&
    IsSearchNumbersPartOfPlaceName(result.structured_address, nums) &&
    !normalizedAddr.includes("番")
  )
    return { ...result, unmatched_address: null };
  const parts = ExtractUnmatchedParts({
    Normalized: normalizedAddr,
    Matched: result.matched_address,
    Search: adjustedSearchAddr,
  });
  return { ...result, unmatched_address: parts.length > 0 ? parts : null };
};

const buildParcelPrefix = (sa: StructuredAddress): string => {
  if (sa.prc_num1 === null) return "";
  if (sa.prc_num2 === null) return sa.prc_num1;
  return sa.prc_num1 + "-" + sa.prc_num2 + (sa.prc_num3 !== null ? "-" + sa.prc_num3 : "");
};

const extractUnmatchedAfterParcel = (afterColon: string, result: MatchedResult): string => {
  const prefix = buildParcelPrefix(result.structured_address);
  if (prefix === "" || !afterColon.startsWith(prefix)) return "";
  return trimPrefix(afterColon.slice(prefix.length), "-");
};

/** 番号まで当てたあとの残り: 地番の後ろ、建物名、正規化した入力の空白の後ろ */
export const setTwoStageUnmatchedAddress = (
  result: MatchedResult,
  normalizedAddr: string,
  parsed: ParsedAddress,
): MatchedResult => {
  const remaining =
    parsed.Numbers.length > 0 ? extractUnmatchedAfterParcel(parsed.Numbers.join("-"), result) : "";
  const extra = [
    ...(remaining !== "" ? [remaining] : []),
    ...(parsed.Building !== "" ? [parsed.Building] : []),
    ...normalizedAddr.split(" ").slice(1),
  ];
  const all = [...(result.unmatched_address ?? []), ...extra];
  return { ...result, unmatched_address: all.length > 0 ? all : null };
};
