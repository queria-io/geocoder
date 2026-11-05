// 町字のあとの番号の書き方が「28街区28号」「25区486番」「15号5番」の住所や、番号のすぐ後ろに
// 建物名が続く住所 (「88プレザンメゾン笠寺」)。上流は番号を住所の終わりでしか切らないので町字止まりにする。
// 番号の並びを「-」でつなぎ、後ろを建物名として空白で分けて当て直す。上流には無い段
import type { MatchedResult } from "./model/model";
import { atMachiaza } from "./skip_aza";

// 数字のあとの「番地」「番」「号」「街区」「区」「の」「-」は、どれも番号の区切りとして読む
const NUMBERS =
  /^(\d+)(?:(?:番地|番|号|街区|区|の|-)(\d+))?(?:(?:番地|番|号|街区|区|の|-)(\d+))?(?:番地|番|号)?/u;

/** 頭の番号の並びを「-」でつなぎ、後ろの文字を空白で分ける。書き直すところが無ければ null */
export const splitNumberTail = (rest: string): string | null => {
  const m = NUMBERS.exec(rest);
  if (!m) return null;
  const numbers = m
    .slice(1)
    .filter((x) => x !== undefined)
    .join("-");
  const tail = rest.slice(m[0].length).trim();
  const rewritten = tail === "" ? numbers : `${numbers} ${tail}`;
  return rewritten === rest ? null : rewritten;
};

export const withNumberTail = async (
  r: MatchedResult,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  if (!atMachiaza(r) || !r.ids.machiaza_id) return r;
  const rest = splitNumberTail(r.unmatched_address?.[0] ?? "");
  if (rest === null) return r;
  const retried = (await match(`${r.matched_address}${rest}`)).find(
    (x) => x.ids.lg_code === r.ids.lg_code && x.ids.machiaza_id === r.ids.machiaza_id,
  );
  if (!retried || atMachiaza(retried)) return r;
  return { ...retried, score: Math.min(retried.score, r.score) };
};
