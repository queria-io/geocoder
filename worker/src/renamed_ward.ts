// 区の再編で無くなった区の名前 (「浜松市浜北区」) で書いた住所。ABR には今の区しか無いので、上流は市区町村止まりにする。
// 旧区の範囲を引き継いだ今の区に読み替えて当て直す。上流には無い段
import { Detail, type MatchedResult } from "./model/model";
import { compareResultStrength, strongestResult } from "./matching/search";

/** 市 + 旧区 → 範囲を引き継いだ今の区 (2024 年 1 月 1 日の浜松市の再編) */
export const RENAMED_WARDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["浜松市中区", ["浜松市中央区"]],
  ["浜松市東区", ["浜松市中央区"]],
  ["浜松市西区", ["浜松市中央区"]],
  ["浜松市南区", ["浜松市中央区"]],
  ["浜松市北区", ["浜松市中央区", "浜松市浜名区"]],
  ["浜松市浜北区", ["浜松市浜名区"]],
]);

export const withRenamedWard = async (
  r: MatchedResult,
  input: string,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  if (Detail(r.match_level) >= Detail("machiaza")) return r;
  const old = [...RENAMED_WARDS.keys()].find((w) => input.includes(w));
  if (old === undefined) return r;
  const tried = await Promise.all(
    (RENAMED_WARDS.get(old) ?? []).map((w) => match(input.replace(old, w))),
  );
  const found = tried.flat().filter((x) => Detail(x.match_level) >= Detail("machiaza"));
  const best = strongestResult(found);
  if (best === undefined || compareResultStrength(best, r) >= 0) return r;
  // 今の区の 2 つで同じ強さに当たれば、どちらか決められないので読み替えない
  const ties = found.filter((x) => compareResultStrength(x, best) === 0);
  if (new Set(ties.map((x) => x.ids.lg_code)).size > 1) return r;
  return best;
};
