// abrg/internal/matching/levenshtein/unmatched.go の写し (upstream/UPSTREAM のコミット)
import type { Str, StructuredAddress } from "../../model/model";
import { KanjiToArabic } from "../../transform/kanji_numbers";
import { RemoveOazaAza } from "../../util/address";
import { IsAddressNumberRune } from "../../util/char";
import { StripChomeSuffix, StripGoSuffix } from "../../util/suffix";
import { ExtractUnmatchedParts, cutPrefix, trimSuffix } from "../unmatched/unmatched";

const matchesPlaceName = (
  placeName: Str,
  searchNumbers: string,
  strip?: (s: string) => string,
): boolean => {
  if (placeName === null || searchNumbers === "") return false;
  const [normalized] = KanjiToArabic(placeName);
  const nums = trimSuffix(searchNumbers, "-");
  if (normalized === nums || placeName === nums) return true;
  return strip !== undefined && (strip(placeName) === nums || strip(normalized) === nums);
};

/** 番号に見えた数字が、実は小字・大字町・丁目の名前の一部 (小字「111」) か */
export const IsSearchNumbersPartOfPlaceName = (
  addr: StructuredAddress,
  searchNumbers: string,
): boolean =>
  matchesPlaceName(addr.koaza, searchNumbers, StripGoSuffix) ||
  matchesPlaceName(addr.oaza_cho, searchNumbers) ||
  matchesPlaceName(addr.chome, searchNumbers, StripChomeSuffix);

const adjustSearchAddrForChome = (
  addr: StructuredAddress,
  searchNumbers: string,
  searchAddr: string,
): string => {
  if (addr.chome === null) return searchAddr;
  const [chomeNum] = KanjiToArabic(StripChomeSuffix(addr.chome));
  const [remaining, found] = cutPrefix(searchNumbers, chomeNum + "-");
  return found ? remaining : searchAddr;
};

const mapNormPosToOriginal = (addrPart: string, normEndPos: number): string => {
  const runes = Array.from(addrPart);
  let [normIdx, origIdx] = [0, 0];
  while (origIdx < runes.length && normIdx < normEndPos) {
    if (runes[origIdx] === "大" && runes[origIdx + 1] === "字") {
      origIdx += 2;
    } else if (runes[origIdx] === "字") {
      origIdx++;
    } else {
      normIdx++;
      origIdx++;
    }
  }
  return runes.slice(origIdx).join("");
};

const fullWidthHyphens = new Set(["−", "－", "ー", "—", "―"]);

/** 残りの番号の書き方をそろえる (全角数字→半角、「番地」「番」→ハイフン、末尾の「号」を外す) */
export const NormalizeUnmatchedNumbers = (s: string): string => {
  const runes = Array.from(s);
  let out = "";
  for (let i = 0; i < runes.length; i++) {
    const r = runes[i];
    const next = runes[i + 1];
    if (r >= "０" && r <= "９") {
      out += String.fromCharCode(r.charCodeAt(0) - 0xfee0);
    } else if (fullWidthHyphens.has(r)) {
      out += "-";
    } else if (r === "番" && next === "地") {
      out += "-";
      i++;
    } else if (r === "番" && next !== undefined && IsAddressNumberRune(next)) {
      out += "-";
    } else if (!(r === "号" && i === runes.length - 1)) {
      out += r;
    }
  }
  return trimSuffix(out, "-");
};

/** 正規化前の住所から、当たった住所の後ろを切り出す (大字・字の有無を読み飛ばして位置を合わせる) */
export const extractUnmatchedSegments = (
  originalAddr: string,
  matchedAddr: string,
): string[] | null => {
  const [addrPart, ...rest] = originalAddr.replaceAll("　", " ").split(" ");
  const buildingParts = rest.length > 0 ? rest.join(" ").split(" ") : [];
  const [addrNorm] = RemoveOazaAza(addrPart);
  const [matchedNorm] = RemoveOazaAza(matchedAddr);
  const matchedRunes = Array.from(matchedNorm);
  let suffix = "";
  if (addrNorm.indexOf(matchedNorm) === 0) {
    suffix = mapNormPosToOriginal(addrPart, matchedRunes.length);
  } else {
    for (let len = Math.min(matchedRunes.length, 15); len >= 2; len--) {
      const tail = matchedRunes.slice(matchedRunes.length - len).join("");
      const idx = addrNorm.lastIndexOf(tail);
      if (idx >= 0) {
        suffix = mapNormPosToOriginal(addrPart, Array.from(addrNorm.slice(0, idx)).length + len);
        break;
      }
    }
  }
  if (suffix !== "") {
    if (suffix.startsWith("字") && /[0-9]/.test(suffix)) suffix = suffix.slice(1);
    suffix = NormalizeUnmatchedNumbers(suffix);
  }
  const result = [...(suffix !== "" ? [suffix] : []), ...buildingParts];
  return result.length > 0 ? result : null;
};

/** あいまい一致で当たった候補の、残りの部分 */
export const extractUnmatchedAddress = (
  searchNumbers: string,
  addr: StructuredAddress,
  category: string,
  searchAddr: string,
  normalizedAddr: string,
  matchedAddr: string,
): string[] | null => {
  const nonEmpty = (xs: string[] | null) => (xs !== null && xs.length > 0 ? xs : null);
  if (searchNumbers !== "") {
    if (IsSearchNumbersPartOfPlaceName(addr, searchNumbers)) return null;
    const adjusted = adjustSearchAddrForChome(addr, searchNumbers, searchAddr);
    const parts = ExtractUnmatchedParts({
      Normalized: normalizedAddr,
      Matched: matchedAddr,
      Search: adjusted,
    });
    if (addr.koaza !== null && matchedAddr.includes(addr.koaza)) {
      if (parts.length === 0) return null;
      if (!/[0-9]/.test(searchNumbers) && addr.koaza.endsWith(searchNumbers)) return null;
    }
    return nonEmpty(parts);
  }
  if (category === "basic" && searchAddr.includes("@"))
    return nonEmpty(
      ExtractUnmatchedParts({
        Normalized: normalizedAddr,
        Matched: matchedAddr,
        Search: searchAddr,
      }),
    );
  const remaining = extractUnmatchedSegments(normalizedAddr, matchedAddr);
  if (addr.koaza !== null && matchedAddr.includes(addr.koaza) && remaining === null) return null;
  return remaining;
};
