// abrg/internal/matching/fallback.go の写し (upstream/UPSTREAM のコミット)
import { All, type MatchedResult } from "../model/model";
import type { NormalizeContext } from "./context";
import { detectMachiaza, queryAddressResults } from "./detect_machiaza";
import { Search } from "./levenshtein/search";
import type { Impl } from "./matcher";
import { parsedString } from "./parsed_addr";
import { queryCityRecord, queryCityRecordFuzzy, queryPrefectureRecord } from "./prefecture";
import {
  adjustSearchAddrForMatch,
  buildCityBasedSearchAddr,
  convertColonToChome,
} from "./search_addr";
import { buildLevenshteinParams } from "./search";
import { setTwoStageUnmatchedAddress, setUnmatchedAddress } from "./unmatched";
import { CreateUnmatchedResult } from "./unmatched/unmatched";

/** 町字が当たっていない住所を、市区町村、あいまい一致の市区町村、都道府県の順に粗くして当てる */
export const handleFallback = async (n: Impl, nctx: NormalizeContext): Promise<MatchedResult[]> => {
  if (nctx.State.BasicResults.length > 0) return handleBasicFallback(n, nctx);
  const city = await tryCityRecordSearch(n, nctx);
  if (city !== null) return city;
  const leven = await tryLevenshteinCitySearch(n, nctx);
  if (leven !== null) return leven;
  const pref = await tryPrefectureRecordSearch(n, nctx);
  if (pref !== null) return pref;
  return [CreateUnmatchedResult(nctx.Input.NormalizedAddr)];
};

/** 市区町村だけの住所 ("鎌ガ谷市"・"柴田郡大河原町") */
const tryCityRecordSearch = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  const s = parsedString(nctx.Input.SearchAddr);
  const r =
    (await queryCityRecord(n, s, nctx.Input.Pref, nctx.Input.NormalizedAddr)) ??
    (await queryCityRecordFuzzy(n, s, nctx.Input.Pref, nctx.Input.NormalizedAddr));
  return r === null ? null : [r];
};

/** 丁目が無い住所 ("神田鍛冶町二丁目") を、あいまい一致で町字か市区町村に */
const tryLevenshteinCitySearch = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  if (nctx.State.SkipLevenshtein) return null;
  const r = await Search(
    n.repo,
    buildLevenshteinParams(n, nctx, nctx.State.LgCode, nctx.State.MachiazaID),
  );
  return r.length > 0 ? r : null;
};

const tryPrefectureRecordSearch = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  if (nctx.Input.Pref === "" || nctx.Input.Pref === All) return null;
  const r = await queryPrefectureRecord(n, nctx.Input.Pref, nctx.Input.NormalizedAddr);
  return r === null ? null : [r];
};

/** 町字が当たったあと、丁目や大字町まで詰められないか試し、残りを入れる */
const handleBasicFallback = async (n: Impl, nctx: NormalizeContext): Promise<MatchedResult[]> => {
  const basic = nctx.State.BasicResults[0];
  const sa = basic.structured_address;
  if (sa.chome === null) {
    if (basic.machiaza.hasChome) {
      const r = await tryChomeSearch(n, nctx);
      if (r !== null) return r;
    } else if (sa.oaza_cho === null) {
      const r = await tryOazaChoSearch(n, nctx);
      if (r !== null) return r;
    }
  }
  // 数字だけの小字 (七尾市大田町111) は、丁目や地番の読みがすべて外れたあとで名前として試す (上流の issue #259)
  if (sa.chome === null && sa.koaza === null) {
    const r = await tryNumericKoazaSearch(n, nctx);
    if (r !== null) return r;
  }
  if (basic.unmatched_address === null && !nctx.State.UsedLevenshtein) {
    const updated = setUnmatchedAddress(
      basic,
      nctx.Input.NormalizedAddr,
      parsedString(nctx.Input.SearchAddr),
    );
    return [updated, ...nctx.State.BasicResults.slice(1)];
  }
  return nctx.State.BasicResults;
};

/** 丁目のある大字町に当たったのに丁目が無いとき、最初の番号を丁目として探し直す */
const tryChomeSearch = async (n: Impl, nctx: NormalizeContext): Promise<MatchedResult[] | null> => {
  const chome = convertColonToChome(nctx.Input.SearchAddr);
  if (chome.HasChome === nctx.Input.SearchAddr.HasChome) return null;
  const [results] = await detectMachiaza(
    n.repo,
    parsedString(chome),
    nctx.Input.Pref,
    nctx.Input.NormalizedAddr,
  );
  if (results.length === 0 || results[0].structured_address.chome === null) return null;
  return [
    setUnmatchedAddress(results[0], nctx.Input.NormalizedAddr, parsedString(nctx.Input.SearchAddr)),
    ...results.slice(1),
  ];
};

/** "7尾市大田町:111" を、数字だけの小字 "7尾市大田町111" として探す */
const tryNumericKoazaSearch = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  const sa = nctx.Input.SearchAddr;
  if (sa.HasChome || sa.LeadingHyphen || sa.Base === "" || sa.Numbers.length === 0) return null;
  const results = await queryAddressResults(
    n.repo,
    sa.Base + sa.Numbers[0],
    nctx.Input.Pref,
    nctx.Input.NormalizedAddr,
  );
  if (results.length === 0 || results[0].structured_address.koaza === null) return null;
  const base = sa.Base + sa.Numbers[0];
  const rest = sa.Numbers.slice(1);
  // 残りの番号を地番として当てる段は未移植。残りはそのまま「当たらなかった部分」に入れる
  const koaza: MatchedResult =
    rest.length > 0
      ? {
          ...results[0],
          unmatched_address: [...(results[0].unmatched_address ?? []), "-" + rest.join("-")],
        }
      : results[0];
  const parsed = {
    ...sa,
    Base: base,
    Numbers: [],
    HasChome: false,
    Chome: "",
    AfterChome: "",
    LeadingHyphen: false,
    Building: "",
  };
  return [
    setTwoStageUnmatchedAddress(koaza, nctx.Input.NormalizedAddr, parsed),
    ...results.slice(1),
  ];
};

/** 市区町村までしか当たっていないとき、最初の番号を丁目とみて大字町を探す */
const tryOazaChoSearch = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  const chome = convertColonToChome(nctx.Input.SearchAddr);
  if (chome.HasChome === nctx.Input.SearchAddr.HasChome) return null;
  const cityBased = buildCityBasedSearchAddr(
    nctx.State.BasicResults[0].structured_address,
    parsedString(chome),
  );
  const [results] = await detectMachiaza(
    n.repo,
    cityBased,
    nctx.Input.Pref,
    nctx.Input.NormalizedAddr,
  );
  if (results.length === 0 || results[0].structured_address.oaza_cho === null) return null;
  const adjusted = adjustSearchAddrForMatch(
    nctx.Input.SearchAddr,
    results[0].structured_address.oaza_cho,
  );
  return [
    setUnmatchedAddress(results[0], nctx.Input.NormalizedAddr, adjusted),
    ...results.slice(1),
  ];
};
