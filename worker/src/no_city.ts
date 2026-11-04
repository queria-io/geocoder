// 市区町村名を書かない住所 (「松川町字市坂3-1」「福島県松川町字市坂3-1」)。上流は都道府県止まりか、何も返さない。
// 町名の索引 (town.town_name) から、その町名を持つ市区町村を引き、市区町村名を補って当て直す。
// 全国で 1 つの町字の名前に決まるときだけ採る。上流には無い段
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

/** 頭 2 文字の索引の鍵。住所が「北1条」なら、表の「北一条」の鍵「北一」も引く */
const keysOf = (rest: string): string[] => {
  const key = rest.slice(0, 2);
  const kanji = key.replace(/[0-9]/g, (d) => KANJI[Number(d)]);
  return kanji === key ? [key] : [key, kanji];
};

const cityName = (c: CityResult) => c.pref + (c.county ?? "") + c.city + (c.ward ?? "");

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

/**
 * 住所に書かれた町字の名前で最も長く当たったものを採る。その名前で当たった市区町村が 2 つ以上
 * あれば、どれか決められないので採らない。番地まで当たったかどうかでは選ばない (片方の市区町村に
 * 番地の点が無いだけのことがある)
 */
const uniqueStrongest = (found: MatchedResult[], rest: string): MatchedResult | undefined => {
  const depth = townDepth(rest);
  const top = Math.max(...found.map(depth));
  const best = found.filter((x) => depth(x) === top);
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
    const tail = rest.slice((w.ward ?? "").length);
    const found = uniqueStrongest(await retry(w, tail, match), tail);
    if (found !== undefined && compareResultStrength(found, r) < 0) return found;
  }
  const byCode = new Map(inPref.map((c) => [c.lgCode, c]));
  const rows = (await Promise.all(keysOf(rest).map(names)))
    .flat()
    .filter((n) => byCode.has(n.lg_code) && numeralsOf(rest).startsWith(numeralsOf(n.name)));
  // 「前田8条」は「前田」でなく「前田八条」を持つ市区町村だけを候補にする
  const longest = Math.max(...rows.map((n) => n.name.length));
  const candidates = [
    ...new Set(
      rows
        .filter((n) => n.name.length === longest)
        .map((n) => byCode.get(n.lg_code))
        .filter((c) => c !== undefined),
    ),
  ];
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATE_CITIES) return r;
  const tried = await Promise.all(candidates.map((c) => retry(c, rest, match)));
  return uniqueStrongest(tried.flat(), rest) ?? r;
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
