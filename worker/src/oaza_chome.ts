// 「扇町屋1-9-34」のように大字を書かない住所。同じ市区町村に「大字扇町屋」(丁目なし、地番) と
// 「扇町屋一丁目」(住居表示) があると、上流は大字を省いた名前で大字に当て、残りを丁目と読まない。
// 大字に当たって残りが番号から始まるとき、大字を外した名前に先頭の番号を丁目として付けて当て直す。上流には無い段
import type { MatchedResult } from "./model/model";
import { advanced, atMachiaza } from "./skip_aza";
import { KanjiToArabic } from "./transform/kanji_numbers";
import { StripChomeSuffix } from "./util/suffix";

/** 丁目の番号 (「三丁目」「3丁」→ 3) */
const chomeNumber = (chome: string): number => Number(KanjiToArabic(StripChomeSuffix(chome))[0]);

export const withOazaChome = async (
  r: MatchedResult,
  input: string,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  const oaza = r.structured_address.oaza_cho;
  const rest = r.unmatched_address?.[0] ?? "";
  const m = /^(\d+)-(\d.*)$/.exec(rest);
  if (!atMachiaza(r) || !oaza?.startsWith("大字") || input.includes("大字") || !m) return r;
  if (r.structured_address.chome !== null || r.structured_address.koaza !== null) return r;
  const name = oaza.slice("大字".length);
  const address = r.matched_address.replace(oaza, `${name}${m[1]}丁目`) + m[2];
  const retried = (await match(address)).find(
    (x) =>
      x.ids.lg_code === r.ids.lg_code &&
      x.structured_address.oaza_cho === name &&
      x.structured_address.chome !== null &&
      // 似た名前の別の丁目に当てたもの (「5丁目」が無くて「3丁目」) は使わない
      chomeNumber(x.structured_address.chome) === Number(m[1]) &&
      // 地番が無く町字止まりでも、残りが番号から始まれば親番の点を引ける (「平須賀2-224」)
      advanced(x),
  );
  return retried ?? r;
};
