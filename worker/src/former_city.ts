// 合併などで無くなった市区町村の名前で書いた住所 (「三重県員弁郡員弁町笠田新田」)。上流は都道府県止まりか、何も返さない。
// 旧市区町村名の索引 (town.former_city) から範囲を引き継いだ今の市区町村を引き、今の名前に読み替えて照合し直す。
// 旧町村名は今の町字名の頭に残ることが多い (いなべ市員弁町笠田新田) ので、残した形と外した形の両方を試す。上流には無い段
import { Detail, type MatchedResult } from "./model/model";
import { compareResultStrength, strongestResult } from "./matching/search";
import type { CityResult } from "./repository/types";
import { townNameOf } from "./no_city";

/** 索引の 1 行。name は旧市区町村名 (郡を付けた形と付けない形)、town_prefix は郡を除いた形 */
export type FormerCityRow = {
  name_key: string;
  name: string;
  town_prefix: string;
  pref_code: string;
  lg_code: string;
  share: number;
};
export const FORMER_CITY_COLUMNS = [
  "name_key",
  "name",
  "town_prefix",
  "pref_code",
  "lg_code",
  "share",
];

/** 試す今の市区町村の上限 (範囲の割合の大きい順) */
const MAX_SUCCESSORS = 6;

/**
 * 都道府県名の無い住所で使う名前。郡まで書いたものか市だけにする。郡の無い町村名 (「本町」「大宮町」) は
 * 全国に同じ名前が多く、今の町字名とも重なるので、市区町村名の無い住所の段 (no_city.ts) に任せる
 */
const specific = (f: FormerCityRow) => f.name !== f.town_prefix || f.name.endsWith("市");

const PREF = /^(東京都|北海道|(京都|大阪)府|.{2,3}県)/;

const cityName = (c: CityResult) => c.pref + (c.county ?? "") + c.city + (c.ward ?? "");

export const withFormerCity = async (
  r: MatchedResult,
  input: string,
  formers: (key: string) => Promise<FormerCityRow[]>,
  city: (lgCode: string) => CityResult | undefined,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  if (Detail(r.match_level) >= Detail("city")) return r;
  const prefCode = r.match_level === "pref" ? r.ids.lg_code?.slice(0, 2) : undefined;
  const all = townNameOf(input);
  const rest = prefCode === undefined ? all : all.replace(PREF, "");
  if (rest.length < 2 || (prefCode !== undefined && rest === all)) return r;
  const rows = (await formers(rest.slice(0, 2))).filter(
    (f) =>
      rest.startsWith(f.name) && (prefCode === undefined ? specific(f) : f.pref_code === prefCode),
  );
  if (rows.length === 0) return r;
  // 「員弁郡員弁町」と「員弁町」の両方に当たれば、長い方 (郡まで書いたもの) だけを使う
  const longest = Math.max(...rows.map((f) => f.name.length));
  const used = rows
    .filter((f) => f.name.length === longest)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_SUCCESSORS);
  const tried = await Promise.all(
    used.map(async (f) => {
      const c = city(f.lg_code);
      if (c === undefined) return [];
      const tail = rest.slice(f.name.length);
      const found = (
        await Promise.all([match(cityName(c) + f.town_prefix + tail), match(cityName(c) + tail)])
      ).flat();
      return found.filter(
        (x) => x.ids.lg_code === c.lgCode && Detail(x.match_level) >= Detail("machiaza"),
      );
    }),
  );
  const found = tried.flat();
  const best = strongestResult(found);
  if (best === undefined || compareResultStrength(best, r) >= 0) return r;
  // 引き継いだ市区町村の 2 つで同じ強さに当たれば、どちらか決められないので読み替えない
  const ties = found.filter((x) => compareResultStrength(x, best) === 0);
  if (new Set(ties.map((x) => x.ids.lg_code)).size > 1) return r;
  return { ...best, former_city: true };
};
