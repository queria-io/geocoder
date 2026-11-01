// abrg/internal/matching/levenshtein/mismatch.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit } from "../../char/char";
import type { MatchedResult, Str } from "../../model/model";
import { KanjiToArabic } from "../../transform/kanji_numbers";
import { TextForDB } from "../../transform/text";
import { ExtractChomeDigits } from "../../util/address";
import type { CityBoundary } from "../../util/city_boundary";
import { StripChomeSuffix } from "../../util/suffix";
import { runeLevenshtein } from "./rune_levenshtein";

/** 入力の丁目 ("1@") と候補の丁目が違うか */
export const hasChomeMismatch = (searchAddr: string, resultChome: Str): boolean => {
  if (resultChome === null) return false;
  const atPos = searchAddr.indexOf("@");
  if (atPos <= 0) return false;
  const searchChome = ExtractChomeDigits(searchAddr.slice(0, atPos));
  if (searchChome === "") return false;
  const [resultNum] = KanjiToArabic(StripChomeSuffix(resultChome));
  return searchChome !== resultNum;
};

const townNamesAgree = (input: string, dbName: string): boolean => {
  const [a, b] = [Array.from(input), Array.from(dbName)];
  if (a.length === 0 || b.length === 0) return true;
  if (a[0] !== b[0]) return false;
  if (input.startsWith(dbName) || dbName.startsWith(input)) return true;
  return runeLevenshtein(input, dbName) <= 1;
};

const extractTownNameFromSearch = (
  boundary: CityBoundary,
  searchAddr: string,
): [string, number] => {
  const cityEnd = boundary.find(searchAddr);
  if (cityEnd <= 0 || cityEnd >= searchAddr.length) return ["", cityEnd];
  const afterCity = searchAddr.slice(cityEnd);
  const idx = afterCity.search(/[0-9@:-]/);
  return [idx >= 0 ? afterCity.slice(0, idx) : afterCity, cityEnd];
};

const isPureNumericContent = (s: string): boolean =>
  s.length > 0 && Array.from(s).every((ch) => IsASCIIDigit(ch) || ch === "-" || ch === ":");

/**
 * あいまい一致の候補の町名が、入力の町名と別物か。頭の 1 文字が違うか、2 文字以上違えば別物とみる。
 * 京都の通り名は町名の前に付くので比べない
 */
export const hasTownNameMismatch = (
  boundary: CityBoundary,
  searchAddr: string,
  result: MatchedResult | undefined,
): boolean => {
  if (!result || result.structured_address.oaza_cho === null) return false;
  if (result.structured_address.kyoto_st !== null) return false;
  const [inputTown, cityEnd] = extractTownNameFromSearch(boundary, searchAddr);
  if (inputTown === "") {
    return (
      cityEnd > 0 && cityEnd < searchAddr.length && isPureNumericContent(searchAddr.slice(cityEnd))
    );
  }
  const raw = result.structured_address.oaza_cho;
  if (townNamesAgree(inputTown, raw)) return false;
  return !townNamesAgree(inputTown, TextForDB(raw)[0]);
};
