// abrg/internal/matching/search_addr.go の写し (upstream/UPSTREAM のコミット)
import type { Str, StructuredAddress } from "../model/model";
import { extractFirstNumber } from "./number_match";
import { parsedString, type ParsedAddress } from "./parsed_addr";

/** 当たった町字の名前の数字 (「1丁目」の 1) を、検索文字から外す */
export const adjustSearchAddrForMatch = (parsed: ParsedAddress, source: Str): string => {
  if (source === null) return parsedString(parsed);
  const sourceNum = extractFirstNumber(source);
  if (sourceNum === "") return parsedString(parsed);
  if (parsed.HasChome && parsed.Chome === sourceNum)
    return parsedString({ ...parsed, HasChome: false, Chome: "" });
  if (parsed.Numbers.length > 0) {
    const first = extractFirstNumber(parsed.Numbers[0]);
    if (first !== "" && sourceNum === first)
      return parsedString({ ...parsed, Numbers: parsed.Numbers.slice(1), LeadingHyphen: false });
  }
  return parsedString(parsed);
};

/** 町字の normalized_address は都道府県を含まないので、検索文字を市区町村から始める */
export const buildCityBasedSearchAddr = (
  addr: StructuredAddress,
  chomeSearchAddr: string,
): string => {
  const cityPrefix = (addr.county ?? "") + (addr.city ?? "") + (addr.ward ?? "");
  if (cityPrefix === "") return chomeSearchAddr;
  const idx = chomeSearchAddr.indexOf(cityPrefix);
  return idx >= 0 ? chomeSearchAddr.slice(idx) : chomeSearchAddr;
};

const startsWithAlphaOrKatakana = (s: string): boolean => /^[A-Za-zア-ン]/.test(s);

/** "浦安市舞浜:2-11" の最初の番号を丁目とみなし、"浦安市舞浜2@:11" にする */
export const convertColonToChome = (parsed: ParsedAddress): ParsedAddress => {
  if (parsed.HasChome || parsed.Numbers.length === 0) return parsed;
  if (startsWithAlphaOrKatakana(parsed.Numbers[0])) return parsed;
  const first = extractFirstNumber(parsed.Numbers[0]);
  if (first === "") return parsed;
  return {
    ...parsed,
    Chome: first,
    HasChome: true,
    Numbers: parsed.Numbers.slice(1),
    LeadingHyphen: false,
  };
};
