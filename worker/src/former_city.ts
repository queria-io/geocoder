// 合併などで無くなった市区町村の名前で書いた住所 (「三重県員弁郡員弁町笠田新田」)。上流は都道府県止まりか、何も返さない。
// 旧市区町村名の索引 (town.former_city) から範囲を引き継いだ今の市区町村を引き、今の名前に読み替えて照合し直す。
// 旧町村名は今の町字名の頭に残ることが多い (いなべ市員弁町笠田新田) ので、残した形と外した形の両方を試す。
// 町字まで当たらなくても、書かれた都道府県で旧市区町村名を引けて、引き継いだ市区町村が 1 つなら、市区町村止まりの結果を使う。上流には無い段。
// 上流の市区町村名のあいまい一致は、旧市区町村名を名前の近い今の市区町村に読むことがある (員弁郡員弁町を員弁郡東員町に)。
// 上流が当てた市区町村の名前が住所に書かれていなければ、市区町村まで当たっていても旧市区町村名から読み直す
import { Detail, type MatchedResult } from "./model/model";
import { compareResultStrength, strongestResult } from "./matching/search";
import type { CityResult } from "./repository/types";
import { cityName, PREF, townNameOf } from "./no_city";

/** 索引の 1 行。name は旧市区町村名 (郡を付けた形と付けない形)、town_prefix は郡を除いた形 */
export type FormerCityRow = {
  name_key: string;
  name: string;
  town_prefix: string;
  pref_code: string;
  lg_code: string;
  share: number;
  one_pref?: boolean | null;
};
export const FORMER_CITY_COLUMNS = [
  "name_key",
  "name",
  "town_prefix",
  "pref_code",
  "lg_code",
  "share",
  "one_pref",
];

/** 上流が当てた市区町村の名前 (郡は省いてよい) が、住所の都道府県名の後 (rest) にそのまま書かれているか */
const writesCity = (
  r: MatchedResult,
  rest: string,
  city: (lgCode: string) => CityResult | undefined,
): boolean => {
  const c = r.ids.lg_code === null ? undefined : city(r.ids.lg_code);
  if (c === undefined) return true;
  return [(c.county ?? "") + c.city, c.city].some((n) => rest.startsWith(townNameOf(n)));
};

/** 同じ市区町村か。政令市は市のコードと区のコードがあるので、市の名前で比べる */
const sameCity = (
  a: string,
  b: string | null,
  city: (lgCode: string) => CityResult | undefined,
): boolean => {
  if (b === null) return false;
  if (a === b) return true;
  const x = city(a);
  const y = city(b);
  return x !== undefined && y !== undefined && x.pref === y.pref && x.city === y.city;
};

/** 試す今の市区町村の上限 (範囲の割合の大きい順) */
const MAX_SUCCESSORS = 6;

export const withFormerCity = async (
  r: MatchedResult,
  input: string,
  formers: (key: string) => Promise<FormerCityRow[]>,
  city: (lgCode: string) => CityResult | undefined,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  const all = townNameOf(input);
  const withoutPref = all.replace(PREF, "");
  const atCity = Detail(r.match_level) >= Detail("city");
  const misread = atCity && !writesCity(r, withoutPref, city);
  if (atCity && !misread) return r;
  const hasPref = withoutPref !== all;
  // 都道府県は、上流が都道府県まで当てたときと、読み違えた市区町村の住所に都道府県名が書かれているときに決める
  const prefCode =
    r.ids.lg_code !== null && (r.match_level === "pref" || (misread && hasPref))
      ? r.ids.lg_code.slice(0, 2)
      : undefined;
  const rest = hasPref ? withoutPref : all;
  if (rest.length < 2 || (prefCode !== undefined && !hasPref)) return r;
  // 都道府県名の無い住所では、1 つの都道府県にしか無い名前 (one_pref) だけを使う
  const rows = (await formers(rest.slice(0, 2))).filter(
    (f) =>
      rest.startsWith(f.name) && (prefCode === undefined ? f.one_pref : f.pref_code === prefCode),
  );
  if (rows.length === 0) return r;
  // 上流が当てた市区町村が旧市区町村の範囲を引き継いだ市区町村なら、読み違えではないのでそのまま
  if (misread && rows.some((f) => sameCity(f.lg_code, r.ids.lg_code, city))) return r;
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
      // 結果ごとに、読み替えた後の住所を持たせる。この後の段はその住所から読む
      const found = await Promise.all(
        [cityName(c) + f.town_prefix + tail, cityName(c) + tail].map(async (a) =>
          (await match(a)).map((x) => ({ ...x, former_address: a })),
        ),
      );
      return found
        .flat()
        .filter(
          (x) => sameCity(c.lgCode, x.ids.lg_code, city) && Detail(x.match_level) >= Detail("city"),
        );
    }),
  );
  const found = tried.flat();
  const best = strongestResult(found);
  // 上流が読み違えた市区町村の結果とは強さを比べない
  if (best === undefined || (!misread && compareResultStrength(best, r) >= 0)) return r;
  // 町字まで当たらず市区町村止まりなら、書かれた都道府県で旧市区町村名を引けて、引き継いだ市区町村が 1 つのときだけ使う。
  // 都道府県名の無い住所では、旧市区町村名と同じ名前の町字 (「福村字新舘添」) を、別の都道府県の旧村と読み違える。
  // 都道府県名が書かれていても上流が都道府県を決めなかったときは、索引を都道府県で絞っていないので同じく使わない
  if (
    Detail(best.match_level) < Detail("machiaza") &&
    (prefCode === undefined || new Set(used.map((f) => f.lg_code)).size > 1)
  )
    return r;
  // 引き継いだ市区町村の 2 つで同じ強さに当たれば、どちらか決められないので読み替えない
  const ties = found.filter((x) => compareResultStrength(x, best) === 0);
  if (new Set(ties.map((x) => x.ids.lg_code)).size > 1) return r;
  return best;
};

/**
 * 旧市区町村名から市区町村止まりにしか当たらず、上流が市区町村を決めていなければ、町名から市区町村を推定する段
 * (byTown) を先に試す。町名から町字まで当たれば、読み直しを捨てて町名の結果を使う。町名の頭が同じ都道府県の
 * 旧市区町村名と同じ住所を、旧市区町村の後継の市区町村に決めてしまわないため
 */
export const formerOrTown = async (
  r: MatchedResult,
  reread: MatchedResult,
  byTown: () => Promise<MatchedResult[]>,
): Promise<{ n: MatchedResult; byTown?: MatchedResult[] }> => {
  if (
    reread === r ||
    Detail(reread.match_level) >= Detail("machiaza") ||
    Detail(r.match_level) >= Detail("city")
  )
    return { n: reread };
  const found = await byTown();
  return found.some((x) => Detail(x.match_level) >= Detail("machiaza"))
    ? { n: r, byTown: found }
    : { n: reread };
};
