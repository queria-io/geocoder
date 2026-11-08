// 市区町村名を書かない住所 (「松川町字市坂3-1」「福島県松川町字市坂3-1」)。上流は都道府県止まりか、何も返さない。
// 町名の索引 (town.town_name) から、その町名を持つ市区町村を引き、市区町村名を補って当て直す。
// 同じ町名の市区町村が複数あれば、候補を全部、人口の多い順に返す。上流には無い段
import { type CoordinateLevel, Detail, type MatchedResult } from "./model/model";
import { compareResultStrength, strongestResult } from "./matching/search";
import type { CityResult } from "./repository/types";
import { withStep, type Step } from "./evidence";

/**
 * 町名の索引の 1 行 (町字ごとに 1 行)。name は頭の「大字」を外した大字・町の名前、name_key はその頭 2 文字
 * (1 文字の町名はその 1 文字)。chome は丁目の番号、koaza は小字の名前 (頭の「字」を外す)、numbers はその町字にある
 * 番号 (街区符号・地番の本番) の一覧。chome・koaza・numbers は索引を作り直す前の表には無い
 */
export type TownNameRow = {
  name_key: string;
  name: string;
  lg_code: string;
  chome?: number | null;
  koaza?: string | null;
  numbers?: readonly number[] | null;
};
export const TOWN_NAME_COLUMNS = ["name_key", "name", "lg_code", "chome", "koaza", "numbers"];

/**
 * limit の上限 (src/index.ts の limit と同じ)。市区町村を推定するときも、人口の多い順にこの数の市区町村まで当て直す。
 * 一度に返せるのはこの数までなので、それより先の市区町村は当て直しても返らない
 */
export const MAX_LIMIT = 10;

export const PREF = /^(東京都|北海道|(京都|大阪)府|.{2,3}県)/;

/** 索引と同じ形にそろえる。全角の英数字・空白を直し、頭の「大字」を外し、「ヶ」を「ケ」にする */
export const townNameOf = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/\s/g, "")
    .replace(/^大字/, "")
    .replace(/[ヶヵ]/g, "ケ");

const KANJI = "〇一二三四五六七八九";

/** 「十七」→ 17 (1〜99)。それ以外は undefined */
const kanjiNumber = (k: string): number | undefined => {
  const m = /^([一二三四五六七八九]?)(十?)([一二三四五六七八九]?)$/.exec(k);
  if (m === null || k === "") return undefined;
  const [, tens, ten, ones] = m;
  if (ten === "") return k.length === 1 ? KANJI.indexOf(k) : undefined;
  const t = ten === "" ? 0 : tens === "" ? 1 : KANJI.indexOf(tens);
  return t * 10 + (ones === "" ? 0 : KANJI.indexOf(ones));
};

/** 町名の中の「八条」「十七丁目」の数字を算用数字にする。住所は「8条」と書くことが多い */
export const numeralsOf = (s: string): string =>
  s.replace(/[一二三四五六七八九十]{1,3}(?=条|丁|線|地割)/g, (k) => String(kanjiNumber(k) ?? k));

/**
 * 頭 2 文字の索引の鍵。住所が「北1条」なら、表の「北一条」の鍵「北一」も引く。
 * 1 文字の町名 (「栄3-20-29」の「栄」) の鍵として、頭の 1 文字も引く
 */
const keysOf = (rest: string): string[] => {
  const key = rest.slice(0, 2);
  const kanji = key.replace(/[0-9]/g, (d) => KANJI[Number(d)]);
  return [...new Set([key, kanji, rest.slice(0, 1)])];
};

/**
 * 番号の並びの頭の 2 つ。「5-9-2」「5丁目9番2号」なら [5, 9]、「1928番1」なら [1928, 1]。
 * 頭の番号に「番」「番地」が付いていれば (「3番地5」) 丁目ではないので、banchi を true にする
 */
const leadingNumbers = (tail: string): { numbers: number[]; banchi: boolean } => {
  const m = /^([0-9]+)(丁目|丁|番地?|[-－ー‐の]|$)(?:([0-9]+)(?:番地?|号|[-－ー‐の]|$))?/.exec(
    tail,
  );
  if (m === null) return { numbers: [], banchi: false };
  return {
    numbers: [m[1], m[3]].filter((x) => x !== undefined).map(Number),
    banchi: m[2].startsWith("番"),
  };
};

/**
 * 1 つの市区町村で、住所の町名の後ろに書かれた要素 (小字、丁目、番号) のうち実在するものの数。
 * 小字はその名前の町字があれば、丁目は番号の頭 (「天神5-9-2」の 5) の丁目があれば数える。番号は、丁目があれば
 * その丁目の町字に次の番号 (9) が、丁目が無ければ丁目の無い町字に頭の番号 (「新田1928番1」の 1928) があれば数える
 */
const depthOf = (rows: readonly TownNameRow[], tail: string): number => {
  const plain = tail.replace(/^字/, "");
  const koaza = rows
    .map((n) => n.koaza ?? "")
    .filter((k) => k !== "" && plain.startsWith(k))
    .reduce<string | undefined>(
      (m, k) => (m === undefined || k.length > m.length ? k : m),
      undefined,
    );
  // 小字まで書いてあれば、丁目と番号はその小字の町字の中で探す
  const scoped = koaza === undefined ? rows : rows.filter((n) => n.koaza === koaza);
  const {
    numbers: [first, second],
    banchi,
  } = leadingNumbers(koaza === undefined ? tail : plain.slice(koaza.length));
  const chomeRows = scoped.filter((n) => !banchi && first !== undefined && n.chome === first);
  const number = chomeRows.length > 0 ? second : first;
  const numberRows = chomeRows.length > 0 ? chomeRows : scoped.filter((n) => n.chome == null);
  const numberHit =
    number !== undefined && numberRows.some((n) => (n.numbers ?? []).includes(number));
  return Number(koaza !== undefined) + Number(chomeRows.length > 0) + Number(numberHit);
};

/**
 * 京都市の通り名 (「大宮通今出川上る」「四条通烏丸東入」)。町名の前に書かれるので、町名の索引を引く前に外す。
 * 通り名は京都市の区 (lg_code が 261 で始まる) にしかない
 */
const KYOTO_STREET = /^[^0-9]*?通[^0-9]*?(?:[上下]が?[るル]|[東西]入[るル]?)+/;
const KYOTO_CITY = "261";

export const cityName = (c: CityResult) => c.pref + (c.county ?? "") + c.city + (c.ward ?? "");

/**
 * 当たった町字の名前 (大字・町、丁目、小字) のうち、住所の頭にそのまま書かれている部分の長さ。
 * 番地から読んだ丁目 (「大原町5-20」の 5 丁目) や、住所に無い小字は数えない
 */
const townDepth =
  (rest: string) =>
  (x: MatchedResult): number => {
    const { oaza_cho, chome, koaza } = x.structured_address;
    const head = numeralsOf(rest);
    const parts = [oaza_cho ?? "", chome ?? "", koaza ?? ""];
    return parts
      .map((_, i) => numeralsOf(townNameOf(parts.slice(0, i + 1).join(""))))
      .filter((name) => name !== "" && head.startsWith(name))
      .reduce((m, name) => Math.max(m, name.length), 0);
  };

/** 住所に書かれた町字の名前で最も長く当たったものだけを残す */
const longestTown = (found: MatchedResult[], rest: string): MatchedResult[] => {
  const depth = townDepth(rest);
  const top = Math.max(...found.map(depth));
  return found.filter((x) => depth(x) === top);
};

/** 1 つの市区町村に決まるときだけ、その中で一番強いものを採る */
const uniqueStrongest = (found: MatchedResult[], rest: string): MatchedResult | undefined => {
  const best = longestTown(found, rest);
  return new Set(best.map((x) => x.ids.lg_code)).size === 1 ? strongestResult(best) : undefined;
};

/**
 * 座標を取った点の細かさ。号と地番の点が最も細かく、街区と親番の点が次。
 * 住所の文字を番号まで照合できても、点が町字の代表点なら町字と同じに数える
 */
const POINT_RANK: Record<CoordinateLevel, number> = {
  rsdtdsp_rsdt: 5,
  parcel: 5,
  rsdtdsp_blk: 4,
  parcel_parent: 4,
  machiaza_detail: 3,
  machiaza: 2,
  city: 1,
  pref: 0,
  unknown: 0,
};
const pointRank = (x: MatchedResult) => POINT_RANK[x.coordinate_level ?? x.match_level];

/**
 * 市区町村を推定した候補を、座標を取った点の細かい順、照合レベルの細かい順に並べ直す。同じなら元の順
 * (人口の多い順) を保つ。点は候補ごとに座標を引いた後でないと決まらないので、byCity とは別に呼ぶ
 */
export const orderCandidates = (xs: readonly MatchedResult[]): MatchedResult[] =>
  xs.toSorted(
    (a, b) => pointRank(b) - pointRank(a) || Detail(b.match_level) - Detail(a.match_level),
  );

/**
 * 住所に書かれた町字の名前で最も長く当たった市区町村ごとに一番強いものを採り、座標を取った点の
 * 細かい順、照合レベルの細かい順、人口の多い順に並べる。2 つ以上なら市区町村を推定したことになるので、
 * 候補の数を付ける。番地まで当たらない市区町村も候補から外さない (片方の市区町村に番地の点が
 * 無いだけのことがある)
 */
const byCity = (
  found: MatchedResult[],
  rest: string,
  population: (lgCode: string) => number,
): MatchedResult[] => {
  const best = longestTown(found, rest);
  const codes = [...new Set(best.map((x) => x.ids.lg_code ?? ""))];
  const each = codes
    .map((code) => strongestResult(best.filter((x) => x.ids.lg_code === code)))
    .filter((x) => x !== undefined)
    .toSorted(
      (a, b) =>
        pointRank(b) - pointRank(a) ||
        Detail(b.match_level) - Detail(a.match_level) ||
        population(b.ids.lg_code ?? "") - population(a.ids.lg_code ?? ""),
    );
  return each.length > 1 ? each.map((x) => ({ ...x, candidates: each.length })) : each;
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
): Promise<MatchedResult[]> => {
  if (Detail(r.match_level) >= Detail("city")) return [r];
  const prefCode = r.match_level === "pref" ? r.ids.lg_code?.slice(0, 2) : undefined;
  const all = townNameOf(input);
  const rest = townNameOf(prefCode === undefined ? all : all.replace(PREF, ""));
  if (rest.length < 2 || (prefCode !== undefined && rest === all)) return [r];
  // 京都の通り名から書いた住所 (「大宮通今出川上る観世町117」) は、通り名の後ろの町名で京都市の区を探す。
  // 当て直しには通り名も付けたまま送る (市区町村があれば上流が通り名を読む)
  const street = KYOTO_STREET.exec(rest)?.[0];
  const town = street === undefined ? rest : rest.slice(street.length);
  const inPref = cities.filter(
    (c) =>
      (prefCode === undefined || c.lgCode.startsWith(prefCode)) &&
      (street === undefined || c.lgCode.startsWith(KYOTO_CITY)),
  );
  // 政令市の市名を省いて区から書いた住所 (「北海道西区西野6条」)。その区名を持つ市が都道府県に 1 つだけなら補う
  const wards = inPref.filter((c) => c.ward !== null && c.ward !== "" && rest.startsWith(c.ward));
  if (prefCode !== undefined && new Set(wards.map((c) => c.city)).size === 1) {
    const [w] = wards;
    const tail = rest.slice((w.ward ?? "").length);
    const found = uniqueStrongest(await retry(w, tail, match), tail);
    if (found !== undefined && compareResultStrength(found, r) < 0)
      return [withStep({ ...found, steps: r.steps }, "ward_inferred")];
  }
  const byCode = new Map(inPref.map((c) => [c.lgCode, c]));
  const head = numeralsOf(town);
  const rows = (await Promise.all(keysOf(town).map(names)))
    .flat()
    .filter((n) => byCode.has(n.lg_code) && head.startsWith(numeralsOf(n.name)));
  // 「前田8条」は「前田」でなく「前田八条」を持つ市区町村だけを候補にする
  const longest = Math.max(...rows.map((n) => n.name.length));
  const named = rows.filter((n) => n.name.length === longest);
  // 町名の後ろに書かれた小字・丁目・番号が最も深くまで実在する市区町村を候補にし、人口の多い順に並べる
  const tail = named.length > 0 ? head.slice(numeralsOf(named[0].name).length) : "";
  const depths = [...Map.groupBy(named, (n) => n.lg_code)].flatMap(([code, rows]) => {
    const city = byCode.get(code);
    return city === undefined ? [] : [{ city, depth: depthOf(rows, tail) }];
  });
  if (depths.length === 0) return [r];
  const deepest = Math.max(...depths.map((d) => d.depth));
  const candidates = depths
    .filter((d) => d.depth === deepest)
    .map((d) => d.city)
    .toSorted((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const tried = (
    await Promise.all(candidates.slice(0, MAX_LIMIT).map((c) => retry(c, rest, match)))
  ).flat();
  if (tried.length === 0) return [r];
  const found = byCity(tried, town, (code) => byCode.get(code)?.population ?? 0);
  // 上限で当て直さなかった市区町村も候補の数に含める (当て直して当たらなかった市区町村は数えない)
  const count = found.length + Math.max(0, candidates.length - MAX_LIMIT);
  const steps: Step[] = [
    ...(r.steps ?? []),
    ...(street === undefined ? [] : (["kyoto_street_skipped"] as const)),
    "city_inferred",
  ];
  return found.map((x) => ({ ...x, steps, ...(count > 1 ? { candidates: count } : {}) }));
};
