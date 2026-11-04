// 市区町村名を書かない住所 (「松川町字市坂3-1」「福島県松川町字市坂3-1」)。上流は都道府県止まりか、何も返さない。
// 町名の索引 (town.town_name) から、その町名を持つ市区町村を引き、市区町村名を補って当て直す。
// 全国で 1 つの町字に決まるときだけ採る。上流には無い段
import { Detail, type MatchedResult } from "./model/model";
import { compareResultStrength, strongestResult } from "./matching/search";
import type { CityResult } from "./repository/types";

/** 町名の索引の 1 行。name は頭の「大字」を外した大字・町の名前、name_key はその頭 2 文字 */
export type TownNameRow = { name_key: string; name: string; lg_code: string };
export const TOWN_NAME_COLUMNS = ["name_key", "name", "lg_code"];

/** 候補の市区町村がこれより多ければ当て直さない (よくある町名で読む量が増えすぎる) */
export const MAX_CANDIDATE_CITIES = 8;

const PREF = /^(東京都|北海道|(京都|大阪)府|.{2,3}県)/;

/** 索引と同じ形にそろえる。全角の英数字・空白を直し、頭の「大字」を外し、「ヶ」を「ケ」にする */
export const townNameOf = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/\s/g, "")
    .replace(/^大字/, "")
    .replace(/[ヶヵ]/g, "ケ");

const cityName = (c: CityResult) => c.pref + (c.county ?? "") + c.city + (c.ward ?? "");

/**
 * 町字まで当たったもののうち、最も細かい段まで当たったものを採る。その段まで当たった市区町村が
 * 2 つ以上あれば、どれか決められないので採らない (点数の差では選ばない)
 */
const uniqueStrongest = (found: MatchedResult[]): MatchedResult | undefined => {
  const top = Math.max(...found.map((x) => Detail(x.match_level)));
  const best = found.filter((x) => Detail(x.match_level) === top);
  return new Set(best.map((x) => x.ids.lg_code)).size === 1 ? strongestResult(best) : undefined;
};

/** 市区町村を補った住所で当て直し、その市区町村の町字まで当たったものだけを残す */
const retry = async (
  c: CityResult,
  rest: string,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult[]> =>
  (await match(cityName(c) + rest)).filter(
    (x) => x.ids.lg_code === c.lgCode && Detail(x.match_level) >= Detail("machiaza"),
  );

export const withoutCity = async (
  r: MatchedResult,
  input: string,
  names: (key: string) => Promise<TownNameRow[]>,
  cities: readonly CityResult[],
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  if (Detail(r.match_level) >= Detail("city")) return r;
  const prefCode = r.match_level === "pref" ? r.ids.lg_code?.slice(0, 2) : undefined;
  const all = townNameOf(input);
  const rest = townNameOf(prefCode === undefined ? all : all.replace(PREF, ""));
  if (rest.length < 2 || (prefCode !== undefined && rest === all)) return r;
  const inPref = cities.filter((c) => prefCode === undefined || c.lgCode.startsWith(prefCode));
  // 政令市の市名を省いて区から書いた住所 (「北海道西区西野6条」)。その区名を持つ市が都道府県に 1 つだけなら補う
  const wards = inPref.filter((c) => c.ward !== null && c.ward !== "" && rest.startsWith(c.ward));
  if (prefCode !== undefined && new Set(wards.map((c) => c.city)).size === 1) {
    const [w] = wards;
    const found = uniqueStrongest(await retry(w, rest.slice((w.ward ?? "").length), match));
    if (found !== undefined && compareResultStrength(found, r) < 0) return found;
  }
  const byCode = new Map(inPref.map((c) => [c.lgCode, c]));
  const candidates = [
    ...new Set(
      (await names(rest.slice(0, 2)))
        .filter((n) => rest.startsWith(n.name))
        .map((n) => byCode.get(n.lg_code))
        .filter((c) => c !== undefined),
    ),
  ];
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATE_CITIES) return r;
  const tried = await Promise.all(candidates.map((c) => retry(c, rest, match)));
  return uniqueStrongest(tried.flat()) ?? r;
};

// 都道府県名の前に付いた 1〜2 文字 (「ｼ静岡県浜松市…」)。入力の誤りとみて外す
const LEADING_NOISE =
  /^[\p{Script=Katakana}\p{Script=Hiragana}\p{ASCII}ー]{1,2}(?=東京都|北海道|京都府|大阪府|\p{Script=Han}{2,3}県)/u;

/** 何も当たらず、都道府県名の前に余計な文字があれば、それを外して当て直す */
export const withLeadingNoise = async (
  r: MatchedResult,
  input: string,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  if (Detail(r.match_level) >= Detail("city")) return r;
  const all = townNameOf(input);
  const noise = LEADING_NOISE.exec(all);
  if (noise === null) return r;
  const best = strongestResult(await match(all.slice(noise[0].length)));
  return best !== undefined && compareResultStrength(best, r) < 0 ? best : r;
};
