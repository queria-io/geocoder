// abrg/internal/matching/unmatched/unmatched.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit } from "../../char/char";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../../model/model";
import {
  ExtractChomeDigits,
  ExtractTrailingAddressNumbers,
  RemoveOazaAza,
} from "../../util/address";
import { IsAddressNumberRune, IsKanjiNumeral } from "../../util/char";

/** 何にも当たらなかった結果。入力をそのまま残りに入れる */
export const CreateUnmatchedResult = (originalAddr: string): MatchedResult => ({
  matched_address: "",
  unmatched_address: originalAddr.split(" "),
  match_level: "unknown",
  score: -1,
  ids: emptyIDs(),
  structured_address: emptySA(),
  coordinates: null,
  machiaza: emptyMachiaza(),
});

export type Addresses = { Normalized: string; Matched: string; Search: string };

/** strings.Cut と同じ。sep が無ければ [s, "", false] */
export const cut = (s: string, sep: string): [string, string, boolean] => {
  const i = s.indexOf(sep);
  return i < 0 ? [s, "", false] : [s.slice(0, i), s.slice(i + sep.length), true];
};
export const cutPrefix = (s: string, prefix: string): [string, boolean] =>
  s.startsWith(prefix) ? [s.slice(prefix.length), true] : [s, false];
export const trimSuffix = (s: string, suffix: string): string =>
  suffix !== "" && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;
export const trimPrefix = (s: string, prefix: string): string => cutPrefix(s, prefix)[0];

/** 正規化した住所を、住所の部分と空白の後 (建物名など) に分ける */
export const SplitStandardizedAddress = (normalizedAddr: string): [string, string[]] => {
  const [head, ...rest] = normalizedAddr.split(" ");
  return [head, rest];
};

const isAllDigits = (s: string): boolean => s !== "" && Array.from(s).every(IsASCIIDigit);

/** 頭の都道府県名を外す。都・府・県が 3〜4 文字目にあるときだけ */
export const stripPrefecture = (addr: string): string => {
  if (addr.startsWith("北海道")) return addr.slice("北海道".length);
  const runes = Array.from(addr);
  for (let i = 0; i < Math.min(runes.length, 5); i++) {
    const r = runes[i];
    if ((r === "都" || r === "府" || r === "県") && i >= 2 && i <= 3)
      return runes.slice(i + 1).join("");
  }
  return addr;
};

/** 頭の「字」を外す。ただし後ろが漢数字で終わるとき (字三) だけ */
const stripAzaMarker = (s: string): string => {
  if (!s.startsWith("字")) return s;
  const afterAza = s.slice(1);
  if (afterAza === "") return "";
  const runes = Array.from(afterAza);
  return IsKanjiNumeral(runes[runes.length - 1]) ? afterAza : s;
};

const extractUnmatchedPrefixFromBeforeColon = (
  beforeColon: string,
  matchedAddr: string,
): string => {
  const [normalizedBefore] = RemoveOazaAza(beforeColon);
  const [normalizedMatched] = RemoveOazaAza(stripPrefecture(matchedAddr));
  if (normalizedBefore.startsWith(normalizedMatched)) {
    const rest = normalizedBefore.slice(normalizedMatched.length);
    if (rest !== "") return rest;
  }
  const matchedRunes = Array.from(normalizedMatched);
  for (let len = Math.min(matchedRunes.length, 10); len >= 2; len--) {
    const suffix = matchedRunes.slice(matchedRunes.length - len).join("");
    const idx = normalizedBefore.lastIndexOf(suffix);
    if (idx >= 0) return normalizedBefore.slice(idx + suffix.length);
  }
  return "";
};

/** 元の入力の最後の「号」と、その前の数字 */
const extractOriginalGoNumber = (originalAddr: string): string | null => {
  const runes = Array.from(originalAddr);
  const goIdx = runes.lastIndexOf("号");
  if (goIdx <= 0) return null;
  let start = goIdx - 1;
  while (start >= 0 && IsAddressNumberRune(runes[start])) start--;
  return runes.slice(start + 1, goIdx + 1).join("");
};

const extractUnmatchedWithColonNoAt = (
  originalAddr: string,
  standardizedAddrPart: string,
  matchedAddr: string,
  afterColon: string,
): string => {
  if (afterColon.includes("-")) {
    const first = afterColon.indexOf("-");
    if (first > 0) {
      const leadingNum = afterColon.slice(0, first);
      const chomePattern = leadingNum + "丁目";
      if (matchedAddr.includes(chomePattern) || standardizedAddrPart.includes(chomePattern))
        return afterColon.slice(first + 1);
      if (afterColon.slice(first + 1) === "" && isAllDigits(leadingNum)) return "";
    }
    return afterColon;
  }
  if (matchedAddr.includes("丁目") && isAllDigits(afterColon)) return "";
  if (afterColon.endsWith("号") && originalAddr.includes("号")) {
    const original = extractOriginalGoNumber(originalAddr);
    if (original !== null) return original;
  }
  return afterColon;
};

const extractUnmatchedWithColonAt = (
  originalAddr: string,
  standardizedAddrPart: string,
  matchedAddr: string,
  beforeColon: string,
  afterColon: string,
): string => {
  if (beforeColon.lastIndexOf("@") <= 0) return afterColon;
  const [beforeAt, afterAt] = beforeColon.split("@");
  const chomeNum = ExtractChomeDigits(beforeAt);
  if (chomeNum !== "") {
    if (matchedAddr.includes("丁目")) {
      if (afterAt !== "" && !isAllDigits(afterAt) && !matchedAddr.includes(afterAt))
        return afterColon !== "" ? afterAt + afterColon : afterAt;
      return afterColon;
    }
    const pattern = chomeNum + "丁目";
    const idx = standardizedAddrPart.indexOf(pattern);
    if (idx !== -1) {
      const afterChome = standardizedAddrPart.slice(idx + pattern.length);
      const hasChomeInOriginal = originalAddr.includes(pattern) || originalAddr.includes("丁目");
      if (hasChomeInOriginal && afterChome === afterColon && !afterColon.includes("-"))
        return standardizedAddrPart.slice(idx);
      return afterColon;
    }
    return afterColon !== "" ? chomeNum + "-" + afterColon : chomeNum;
  }
  return afterColon !== "" ? afterColon : matchedAddr;
};

const extractUnmatchedWithColon = (
  originalAddr: string,
  standardizedAddrPart: string,
  matchedAddr: string,
  beforeColon: string,
  afterColon: string,
): string => {
  if (beforeColon.includes("@"))
    return extractUnmatchedWithColonAt(
      originalAddr,
      standardizedAddrPart,
      matchedAddr,
      beforeColon,
      afterColon,
    );
  let prefix = extractUnmatchedPrefixFromBeforeColon(beforeColon, matchedAddr);
  const [after, found] = cutPrefix(standardizedAddrPart, matchedAddr);
  if (found && afterColon !== "") {
    const trimmed = trimSuffix(after, afterColon);
    if (trimmed !== "" && trimmed !== after) {
      const stripped = stripAzaMarker(trimmed);
      if (stripped !== "") prefix = stripped;
    }
  }
  const afterPart = extractUnmatchedWithColonNoAt(
    originalAddr,
    standardizedAddrPart,
    matchedAddr,
    afterColon,
  );
  return prefix + afterPart;
};

const extractUnmatchedWithAt = (searchAddr: string): string => cut(searchAddr, "@")[1];

/** 当たった住所 (Matched) の後に残る部分と、建物名などを返す。Search は ":"・"@" の印付きの検索文字 */
export const ExtractUnmatchedParts = ({ Normalized, Matched, Search }: Addresses): string[] => {
  const [standardizedAddrPart, buildingParts] = SplitStandardizedAddress(Normalized);
  const [beforeColon, afterColon, hasColon] = cut(Search, ":");
  let unmatchedAddr = Matched;
  if (hasColon && afterColon !== "") {
    unmatchedAddr = extractUnmatchedWithColon(
      Normalized,
      standardizedAddrPart,
      Matched,
      beforeColon,
      afterColon,
    );
  } else if (Search === "") {
    unmatchedAddr = "";
  } else if (Search.includes("@") && !hasColon) {
    unmatchedAddr = extractUnmatchedWithAt(Search);
  } else if (!hasColon) {
    const [after, isPrefix] = cutPrefix(standardizedAddrPart, Matched);
    unmatchedAddr = isPrefix ? after : ExtractTrailingAddressNumbers(Search);
  }
  return [...(unmatchedAddr !== "" ? [unmatchedAddr] : []), ...buildingParts];
};
