// abrg/internal/matching/levenshtein/jaccard.go の写し (upstream/UPSTREAM のコミット)
import type { MatchedResult } from "../../model/model";

const buildBigrams = (runes: string[]): Set<string> =>
  new Set(runes.slice(0, -1).map((r, i) => r + runes[i + 1]));

const buildMatchedAddress = ({ structured_address: sa }: MatchedResult): string =>
  [sa.pref, sa.county, sa.city, sa.ward, sa.kyoto_st, sa.oaza_cho, sa.chome, sa.koaza]
    .map((p) => p ?? "")
    .join("");

const jaccardAgainst = (s1: string, bigrams1: Set<string>, s2: string): number => {
  if (s1 === s2) return 1;
  const bigrams2 = buildBigrams(Array.from(s2));
  if (bigrams1.size === 0 || bigrams2.size === 0) return 0;
  const intersection = [...bigrams1].filter((b) => bigrams2.has(b)).length;
  const union = bigrams1.size + bigrams2.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

/**
 * 正規化すると同じになる候補 (大一本松・大1本松) から、入力の書き方にいちばん近いものを 1 つ選ぶ。
 * 2 文字ずつの組の重なり (Jaccard 係数) で比べ、同点なら先の候補
 */
export const SelectBestByJaccard = (
  results: MatchedResult[],
  originalAddr: string,
): MatchedResult[] => {
  if (results.length <= 1) return results;
  const orig = buildBigrams(Array.from(originalAddr));
  const sims = results.map((r) => jaccardAgainst(originalAddr, orig, buildMatchedAddress(r)));
  const best = sims.reduce((bi, s, i) => (s > sims[bi] ? i : bi), 0);
  return [results[best]];
};
