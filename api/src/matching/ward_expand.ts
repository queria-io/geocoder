// abrg/internal/matching/ward_expand.go の写し (upstream/UPSTREAM のコミット)
import {
  All,
  Detail,
  type MatchedResult,
  type MatchQuery,
  type NormalizeCategory,
} from "../model/model";
import { TextForDB } from "../transform/text";
import type { Impl, WardCandidate } from "./matcher";
import { compareResultStrength, sortAndLimitResults, strongestResult } from "./search";

type MatchNormalized = (
  query: MatchQuery,
  normalizedAddr: string,
  addressType: NormalizeCategory,
  skipLevenshtein: boolean,
) => Promise<MatchedResult[]>;

const reachedMachiaza = (r: MatchedResult): boolean => Detail(r.match_level) >= Detail("machiaza");

const extractWardPrefix = (addr: string): string => {
  const i = addr.indexOf("区");
  return i > 0 ? addr.slice(0, i + 1) : "";
};

const runWardCandidates = async (
  match: MatchNormalized,
  query: MatchQuery,
  candidates: WardCandidate[],
  remainder: string,
  addressType: NormalizeCategory,
  skipLevenshtein: boolean,
): Promise<MatchedResult[]> => {
  const all = await Promise.all(
    candidates.map((c) => match(query, c.CityWard + remainder, addressType, skipLevenshtein)),
  );
  return all.flat();
};

/**
 * 区から書いた住所 ("中区本町") を、その区を持つ市ごとに頭に付けて当て直す。
 * 元の結果より強いものがあったときだけ返す
 */
export const tryWardExpansion = async (
  n: Impl,
  match: MatchNormalized,
  query: MatchQuery,
  normalizedAddr: string,
  addressType: NormalizeCategory,
  baseResults: MatchedResult[],
): Promise<MatchedResult[] | null> => {
  if (query.pref !== All && query.pref !== "") return null;
  const base = strongestResult(baseResults);
  if (base !== undefined && base.score >= 1 && Detail(base.match_level) >= Detail("machiaza"))
    return null;
  const ward = extractWardPrefix(normalizedAddr);
  const candidates = n.wardCandidates.get(TextForDB(ward)[0]) ?? [];
  if (candidates.length === 0) return null;
  const remainder = normalizedAddr.slice(ward.length);
  // あいまい一致は重いので、まず無しで全部の候補を流し、町字まで当たる市があれば終える
  let results = await runWardCandidates(match, query, candidates, remainder, addressType, true);
  if (!results.some(reachedMachiaza))
    results = await runWardCandidates(match, query, candidates, remainder, addressType, false);
  const best = strongestResult(results);
  if (best === undefined || (base !== undefined && compareResultStrength(best, base) >= 0))
    return null;
  // 弱い候補は区の名前が同じだけの別の市なので捨てる
  return sortAndLimitResults(
    results.filter((r) => compareResultStrength(r, best) <= 0),
    query.limit,
  );
};
