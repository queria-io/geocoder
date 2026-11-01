// abrg/internal/matching/search.go の写し (upstream/UPSTREAM のコミット)
import { Detail, type MatchedResult } from "../model/model";
import type { NormalizeContext, NormalizeState } from "./context";
import { detectLgCode } from "./basic_detect";
import { handleFallback } from "./fallback";
import {
  capScoresToFuzzy,
  consumedParcelPrefix,
  fuzzyMatchAllowsTwoStage,
} from "./fuzzy_continuation";
import { Search, type SearchParams } from "./levenshtein/search";
import type { Impl } from "./matcher";
import { parsedString } from "./parsed_addr";
import { tryTwoStageParcel, tryTwoStageResidential } from "./two_stage";

/** 点の差がこれ以下なら同点 */
const scoreEpsilon = 0.002;

/** 強い順: 点が高い方、同点なら細かい段まで当たった方 */
export const compareResultStrength = (a: MatchedResult, b: MatchedResult): number => {
  const diff = a.score - b.score;
  if (diff > scoreEpsilon) return -1;
  if (diff < -scoreEpsilon) return 1;
  return Detail(b.match_level) - Detail(a.match_level);
};

export const sortAndLimitResults = (results: MatchedResult[], limit: number): MatchedResult[] =>
  results.toSorted(compareResultStrength).slice(0, limit);

export const strongestResult = (results: MatchedResult[]): MatchedResult | undefined =>
  results.reduce<MatchedResult | undefined>(
    (best, r) => (best === undefined || compareResultStrength(r, best) < 0 ? r : best),
    undefined,
  );

export const buildLevenshteinParams = (
  n: Impl,
  nctx: NormalizeContext,
  lgCode: string,
  machiazaId: string,
): SearchParams => ({
  Category: "basic",
  SearchAddr: parsedString(nctx.Input.SearchAddr),
  Pref: nctx.Input.Pref,
  LgCode: lgCode,
  MachiazaID: machiazaId,
  NormalizedAddr: nctx.Input.NormalizedAddr,
  Limit: nctx.Input.Limit,
  CityBoundary: n.cityBoundary,
});

/** ぴったりの町字が無ければ、編集距離で探す。市区町村だけの住所 ("柴田郡大河原町") は探さない */
const tryLevenshteinFallback = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<[NormalizeState, boolean]> => {
  const state = nctx.State;
  if (state.BasicResults.length > 0 || state.SkipLevenshtein) return [state, false];
  const s = parsedString(nctx.Input.SearchAddr);
  const cityEnd = n.cityBoundary.find(s);
  if (cityEnd > 0 && cityEnd === s.length) return [state, false];
  const lgCode = state.LgCode === "" ? detectLgCode(n, s) : state.LgCode;
  const results = await Search(n.repo, buildLevenshteinParams(n, nctx, lgCode, state.MachiazaID));
  const searched = { ...state, LgCode: lgCode, SkipLevenshtein: true };
  if (results.length === 0) return [searched, false];
  return [
    {
      ...searched,
      BasicResults: results,
      UsedLevenshtein: true,
      LgCode: results[0].ids.lg_code ?? "",
      MachiazaID: results[0].ids.machiaza_id ?? "",
    },
    true,
  ];
};

/** 住所の種類に合わせて、住居表示と地番の段を流す */
const tryDetailedSearch = async (n: Impl, nctx: NormalizeContext): Promise<MatchedResult[]> => {
  switch (nctx.Input.AddressType) {
    case "rsdtdsp":
      return (await tryTwoStageResidential(n, nctx)) ?? [];
    case "parcel": {
      // 上流には無い。「1番地3」と書かれていても住居表示の区域なら地番は無いので、住居表示でも探す
      const parcel = (await tryTwoStageParcel(n, nctx)) ?? [];
      return parcel.length > 0 ? parcel : ((await tryTwoStageResidential(n, nctx)) ?? []);
    }
    default: {
      const residential = (await tryTwoStageResidential(n, nctx)) ?? [];
      const complete =
        residential.length > 0 &&
        residential[0].score === 1 &&
        residential[0].match_level === "rsdtdsp_rsdt";
      if (complete) return residential;
      return [...residential, ...((await tryTwoStageParcel(n, nctx)) ?? [])];
    }
  }
};

/** 全部の段を試して、いちばん強い結果を返す */
export const normalizeAll = async (n: Impl, nctx: NormalizeContext): Promise<MatchedResult[]> => {
  // あいまい一致で町字が当たったら、番号は町名の誤字 1 文字か地番の頭の文字のときだけ当てに行く
  // (福室字久保野:2-5 の 2-5 を丁目と番号に読み違えないように)
  const [state, usedLeven] = await tryLevenshteinFallback(n, nctx);
  const ctx: NormalizeContext = { ...nctx, State: state };
  const [allows, parcelPrefix] = usedLeven ? fuzzyMatchAllowsTwoStage(n, ctx) : [false, ""];
  let results: MatchedResult[] = [];
  if (!usedLeven || allows) {
    const onPrefixPath = parcelPrefix !== "";
    results = onPrefixPath
      ? ((await tryTwoStageParcel(n, ctx)) ?? [])
      : await tryDetailedSearch(n, ctx);
    if (onPrefixPath && !consumedParcelPrefix(results, parcelPrefix)) results = [];
    if (usedLeven && !onPrefixPath && ctx.State.BasicResults.length > 0)
      results = capScoresToFuzzy(results, ctx.State.BasicResults[0].score);
  }
  if (results.length === 0) results = await handleFallback(n, ctx);
  return sortAndLimitResults(results, ctx.Input.Limit);
};
