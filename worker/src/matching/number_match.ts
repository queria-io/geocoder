// abrg/internal/matching/number_match.go の写し (upstream/UPSTREAM のコミット)
import { KanjiToArabic } from "../transform/kanji_numbers";

const leadingDigitRun = (s: string): string => s.match(/[0-9]+/)?.[0] ?? "";

/** 最初の数字の並び。数字が無ければ漢数字を直してから探す */
export const extractFirstNumber = (s: string): string => {
  if (s === "") return "";
  const run = leadingDigitRun(s);
  if (run !== "") return run;
  const [converted, changed] = KanjiToArabic(s);
  return changed ? leadingDigitRun(converted) : "";
};
