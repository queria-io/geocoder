// abrg/internal/util/address.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit } from "../char/char";
import { IsAddressNumberRune } from "./char";

const oazaAzaPattern = /大字|小字/g;

/**
 * 大字・小字と、単独の字を除く。数字の後の字 (1字・十字・弐字) は小字の名前なので残す
 */
export const RemoveOazaAza = (s: string): [string, boolean] => {
  if (!s.includes("字")) return [s, false];
  const runes = Array.from(s.replace(oazaAzaPattern, ""));
  const result = runes
    .filter((r, i) => r !== "字" || (i !== 0 && IsAddressNumberRune(runes[i - 1])))
    .join("");
  return [result, result !== s];
};

const extractTrailing = (s: string, match: (c: string) => boolean): string => {
  let i = s.length - 1;
  while (i >= 0 && match(s[i])) i--;
  return s.slice(i + 1);
};

/** 末尾の数字とハイフンの並び ("中央区:1-2" → "1-2") */
export const ExtractTrailingAddressNumbers = (s: string): string =>
  extractTrailing(s, (c) => IsASCIIDigit(c) || c === "-");

/** 末尾の数字 ("港区虎ノ門1" → "1") */
export const ExtractChomeDigits = (s: string): string => extractTrailing(s, IsASCIIDigit);

/** あいまい一致で許す編集距離。上流は UTF-8 のバイト数で決める */
export const MaxEditDistance = (byteLen: number): number => Math.max(Math.floor(byteLen / 3), 3);
