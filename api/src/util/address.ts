// abrg/internal/util/address.go の写し (upstream/UPSTREAM のコミット)。transform が使う分だけ
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
