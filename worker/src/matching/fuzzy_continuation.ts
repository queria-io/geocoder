// abrg/internal/matching/fuzzy_continuation.go の写し (upstream/UPSTREAM のコミット)
import type { MatchedResult } from "../model/model";
import { TextForDB } from "../transform/text";
import { KanaSpellings } from "../util/char";
import type { NormalizeContext } from "./context";
import type { Impl } from "./matcher";
import { parcelNumberPrefix } from "./parsed_addr";

const townPortion = (n: Impl, addr: string): string => {
  const end = n.cityBoundary.find(addr);
  return end <= 0 || end >= addr.length ? "" : addr.slice(end);
};

const matchedTownName = (r: MatchedResult): string =>
  TextForDB((r.structured_address.oaza_cho ?? "") + (r.structured_address.koaza ?? ""))[0];

/** 同じ長さで 1 文字だけ違う (紀●井町 と 紀尾井町) */
const isPureSubstitution = (a: string, b: string): boolean => {
  const [ra, rb] = [Array.from(a), Array.from(b)];
  if (ra.length === 0 || ra.length !== rb.length) return false;
  return ra.filter((r, i) => r !== rb[i]).length <= 1;
};

/**
 * あいまい一致で町字が当たったあと、番号まで進めてよいか。町名の 1 文字の誤字か、
 * 地番の頭の文字 (白浜町甲402 の甲) が町名の後に付いただけのときに限る
 */
export const fuzzyMatchAllowsTwoStage = (n: Impl, nctx: NormalizeContext): [boolean, string] => {
  const best = nctx.State.BasicResults[0];
  if (best === undefined) return [false, ""];
  const inputTown = townPortion(n, nctx.Input.SearchAddr.Base);
  if (inputTown === "") return [false, ""];
  const prefix = parcelNumberPrefix(nctx.Input.SearchAddr);
  if (
    prefix !== "" &&
    inputTown.endsWith(prefix) &&
    inputTown.slice(0, -prefix.length) === matchedTownName(best)
  )
    return [true, prefix];
  const matchedTown = townPortion(n, best.matched_address);
  if (matchedTown === "") return [false, ""];
  return [isPureSubstitution(inputTown, matchedTown), ""];
};

export const consumedParcelPrefix = (results: MatchedResult[], prefix: string): boolean => {
  if (results.length === 0 || prefix === "") return false;
  const num1 = results[0].structured_address.prc_num1 ?? "";
  return KanaSpellings(prefix).some((s) => num1.startsWith(s));
};

export const capScoresToFuzzy = (results: MatchedResult[], fuzzyScore: number): MatchedResult[] =>
  results.map((r) => (r.score > fuzzyScore ? { ...r, score: fuzzyScore } : r));
