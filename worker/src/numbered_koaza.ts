// 「1字」「15字」のような番号の小字を持つ大字・町で、小字の番号と地番を「西下野町15-12」と書いた住所。
// 上流は大字・町止まりにする (「15-12」を大字・町の地番と読むが、地番は小字ごとに振られている)。
// 頭の番号を小字の番号と読み、「西下野町15字12」として再照合する。上流には無い段
import type { MatchedResult } from "./model/model";
import { atMachiaza } from "./skip_aza";

const LEADING_NUMBER = /^(\d+)(?:[-‐‑–—―−ー－](.*))?$/u;

/** 残りの頭の番号を小字の番号として「N字…」に書き直す。番号で始まらなければ null */
export const asNumberedKoaza = (rest: string): string | null => {
  const m = LEADING_NUMBER.exec(rest);
  if (!m) return null;
  return `${m[1]}字${m[2] ?? ""}`;
};

export const withNumberedKoaza = async (
  r: MatchedResult,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  // 大字・町 (町字 ID の末尾が 000) に照合できた住所だけ
  if (!atMachiaza(r) || !r.ids.machiaza_id?.endsWith("000")) return r;
  const rest = asNumberedKoaza(r.unmatched_address?.[0] ?? "");
  if (rest === null) return r;
  const koaza = `${r.matched_address}${rest.slice(0, rest.indexOf("字") + 1)}`;
  // 同じ大字・町の「N字」の小字に照合できたときだけ採る
  const retried = (await match(`${r.matched_address}${rest}`)).find(
    (x) =>
      x.ids.lg_code === r.ids.lg_code &&
      x.ids.machiaza_id?.slice(0, 4) === r.ids.machiaza_id?.slice(0, 4) &&
      x.matched_address.startsWith(koaza),
  );
  if (!retried) return r;
  return { ...retried, score: Math.min(retried.score, r.score) };
};
