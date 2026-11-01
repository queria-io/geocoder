// abrg/internal/matching/detect_machiaza.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit } from "../char/char";
import type { MatchedResult } from "../model/model";
import { BasicResultToNormalized, type Repository } from "../repository/types";
import { ExtractSenGoSuffix } from "../transform/hokkaido";
import { SelectBestByJaccard } from "./levenshtein/jaccard";
import { cut, trimPrefix } from "./unmatched/unmatched";

/** 同じ normalized_address で字の書き方だけ違う行 (大一本松と大1本松) を並べて選ぶため、5 件まで引く */
const maxJaccardCandidates = 5;

/** "11-2街区" のように N-M の後に続くと町字の名前の一部になる語 */
const koazaSuffixes = ["街区", "地割", "分区", "番川", "番通"];

export const skipDigits = (s: string, start: number): number => {
  let i = start;
  while (i < s.length && IsASCIIDigit(s[i])) i++;
  return i;
};

/** 最初の "N-M" の位置で分ける。"大塚1-" のように末尾がハイフンなら丁目の印とみる */
const extractFirstNumberWithHyphen = (address: string): [string, string, boolean, boolean] => {
  for (let i = 0; i < address.length; i++) {
    if (!IsASCIIDigit(address[i])) continue;
    const numEnd = skipDigits(address, i);
    if (numEnd >= address.length || address[numEnd] !== "-") continue;
    if (numEnd + 1 >= address.length)
      return [address.slice(0, i), address.slice(i, numEnd), true, true];
    if (!IsASCIIDigit(address[numEnd + 1])) continue;
    const secondEnd = skipDigits(address, numEnd + 1);
    if (koazaSuffixes.some((s) => address.startsWith(s, secondEnd))) {
      i = secondEnd - 1;
      continue;
    }
    return [address.slice(0, i), address.slice(i), true, false];
  }
  return ["", "", false, false];
};

/** ("千代田区紀尾井町", "1-3") → ("千代田区紀尾井町1@", ":3") */
const buildFallbackAddress = (base: string, afterColon: string): [string, string] => {
  const end = skipDigits(afterColon, 0);
  if (end === 0) return ["", ""];
  const rest = trimPrefix(afterColon.slice(end), "-");
  return [base + afterColon.slice(0, end) + "@", rest === "" ? "" : ":" + rest];
};

/** 一部だけ住居表示の町字は、住居表示と地番のどちらの住所か決まらないので、印を null にする (上流の issue #262) */
const hasAmbiguousRsdtAddrFlg = (results: MatchedResult[]): Set<string> => {
  const seen = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { ids } of results) {
    if (ids.lg_code === null || ids.machiaza_id === null || ids.rsdt_addr_flg === null) continue;
    const key = ids.lg_code + ids.machiaza_id;
    const prev = seen.get(key);
    if (prev !== undefined && prev !== ids.rsdt_addr_flg) ambiguous.add(key);
    seen.set(key, ids.rsdt_addr_flg);
  }
  return ambiguous;
};

/** normalized_address がぴったり同じ町字を引く。候補が複数なら入力の書き方に近いものを選ぶ */
export const queryAddressResults = async (
  repo: Repository,
  address: string,
  prefCode: string,
  originalAddr: string,
): Promise<MatchedResult[]> => {
  const rows = await repo.FindBasicByAddress({ address, prefCode, limit: maxJaccardCandidates });
  const all = rows.map(BasicResultToNormalized);
  const ambiguous = hasAmbiguousRsdtAddrFlg(all);
  const results =
    all.length > 1
      ? originalAddr !== ""
        ? SelectBestByJaccard(all, originalAddr)
        : all.slice(0, 1)
      : all;
  return results.map((r) =>
    r.ids.lg_code !== null &&
    r.ids.machiaza_id !== null &&
    ambiguous.has(r.ids.lg_code + r.ids.machiaza_id)
      ? { ...r, ids: { ...r.ids, rsdt_addr_flg: null } }
      : r,
  );
};

const handleBaseMatch = (
  results: MatchedResult[],
  base: string,
  afterColon: string,
  address: string,
  found: boolean,
  wasHyphenated: boolean,
): [MatchedResult[], string] => {
  if (!wasHyphenated) return [results, found ? address : ""];
  return [results, afterColon.includes("-") ? base + ":" + afterColon : base + afterColon + "@"];
};

/**
 * 町字を探す。"町字名:番号" の町字名、だめなら最初の番号を丁目とみた "町字名N@"、
 * 北海道の "N線M号" の順に試す。返す 2 つ目は、見つけた形に直した検索文字
 */
export const detectMachiaza = async (
  repo: Repository,
  address: string,
  prefCode: string,
  originalAddr: string,
): Promise<[MatchedResult[], string]> => {
  let [base, afterColon, found] = cut(address, ":");
  let wasHyphenated = false;
  let trailing = false;
  if (!found) {
    const [b, a, hyphen, t] = extractFirstNumberWithHyphen(address);
    if (hyphen) [base, afterColon, found, wasHyphenated, trailing] = [b, a, true, true, t];
  }
  // "銀座1丁目-5-2" → "銀座1@-5-2": 丁目の印の直後に番号が続く
  if (!found) {
    const at = address.indexOf("@-");
    if (at >= 0 && IsASCIIDigit(address[at + 2] ?? "")) {
      [base, afterColon, found] = [address.slice(0, at + 1), address.slice(at + 2), true];
    }
  }
  const searchKey = trailing ? base + afterColon + "@" : base;
  const results = await queryAddressResults(repo, searchKey, prefCode, originalAddr);
  if (results.length > 0)
    return handleBaseMatch(results, base, afterColon, address, found, wasHyphenated);

  if (found) {
    const [fbBase, fbAfter] = buildFallbackAddress(base, afterColon);
    if (fbBase !== "") {
      const r = await queryAddressResults(repo, fbBase, prefCode, originalAddr);
      if (r.length > 0) return [r, fbBase + fbAfter];
    }
  }

  const [senBase, senSuffix, hasSenGo] = ExtractSenGoSuffix(address);
  if (hasSenGo) {
    const r = await queryAddressResults(repo, senBase, prefCode, originalAddr);
    if (r.length > 0) return [r, senBase + ":" + senSuffix];
  }
  return [[], address];
};
