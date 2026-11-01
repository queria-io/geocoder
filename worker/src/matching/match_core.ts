// abrg/internal/matching/match_core.go の写し (upstream/UPSTREAM のコミット)
import { All, type MatchedResult, type MatchQuery, type NormalizeCategory } from "../model/model";
import { BasicNormalizeInput } from "../normalize/input";
import { NormalizeBasicNormalized } from "../normalize/normalize";
import { detectBasicResultsWithBasic } from "./basic_detect";
import type { NormalizeContext } from "./context";
import { handleFallback } from "./fallback";
import type { Impl } from "./matcher";
import { parseSearchAddr } from "./parsed_addr";
import { normalizeAll } from "./search";
import { tryTwoStageParcel, tryTwoStageResidential } from "./two_stage";
import { CreateUnmatchedResult } from "./unmatched/unmatched";
import { tryWardExpansion } from "./ward_expand";

const normalizeByCategory = async (n: Impl, nctx: NormalizeContext): Promise<MatchedResult[]> => {
  switch (nctx.Input.Category) {
    case "basic":
      return handleFallback(n, nctx);
    case "rsdtdsp":
      return (await tryTwoStageResidential(n, nctx)) ?? handleFallback(n, nctx);
    case "parcel":
      return (await tryTwoStageParcel(n, nctx)) ?? handleFallback(n, nctx);
    default:
      return normalizeAll(n, nctx);
  }
};

/** 正規化した住所に、都道府県から町字 (と番号) までを当てる */
const matchNormalized =
  (n: Impl) =>
  async (
    query: MatchQuery,
    normalizedAddr: string,
    addressType: NormalizeCategory,
    skipLevenshtein: boolean,
  ): Promise<MatchedResult[]> => {
    const [pref, searchAddr, basicResults] = await detectBasicResultsWithBasic(
      n,
      normalizedAddr,
      query.pref,
    );
    const lgCode = basicResults[0]?.ids.lg_code ?? "";
    const machiazaId = basicResults[0]?.ids.machiaza_id ?? "";
    // 都道府県も市区町村も無い住所は、当てる先が無いのでここで諦める
    if (pref === All && lgCode === "" && machiazaId === "" && n.cityBoundary.find(searchAddr) <= 0)
      return [CreateUnmatchedResult(normalizedAddr)];
    return normalizeByCategory(n, {
      Input: {
        NormalizedAddr: normalizedAddr,
        SearchAddr: parseSearchAddr(searchAddr),
        Pref: pref,
        Limit: query.limit,
        Category: query.category,
        AddressType: addressType,
      },
      State: {
        LgCode: lgCode,
        MachiazaID: machiazaId,
        BasicResults: basicResults,
        UsedLevenshtein: false,
        SkipLevenshtein: skipLevenshtein,
      },
    });
  };

/** 住所の文字列を正規化して当てる。区から書いた住所は、その区を持つ市ごとにも試す */
export const Match = async (n: Impl, q: MatchQuery): Promise<MatchedResult[]> => {
  const query = { ...q, limit: q.limit > 0 ? q.limit : 1 };
  const [normalizedAddr, addressType] = NormalizeBasicNormalized(
    BasicNormalizeInput(query.address),
  );
  const match = matchNormalized(n);
  const results = await match(query, normalizedAddr, addressType, false);
  const expanded = await tryWardExpansion(n, match, query, normalizedAddr, addressType, results);
  return (expanded ?? results).map((r) => ({
    ...r,
    unmatched_address:
      r.unmatched_address !== null && r.unmatched_address.length > 0 ? r.unmatched_address : null,
  }));
};
