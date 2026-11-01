// abrg/internal/transform/kanji_numbers.go の写し (upstream/UPSTREAM のコミット)
import { IsKanjiNumeral } from "../util/char";

const formalKanji: Record<string, string> = {
  壱: "一",
  弐: "二",
  参: "三",
  肆: "四",
  伍: "五",
  陸: "六",
  漆: "七",
  捌: "八",
  玖: "九",
  拾: "十",
};
const formalKanjiPattern = /[壱弐参肆伍陸漆捌玖拾]/gu;
const replaceFormalKanji = (s: string): string =>
  s.replace(formalKanjiPattern, (r) => formalKanji[r]);

/** 漢数字を作りうる文字の全部 (万・億も含む)。この中の漢数字の文字クラスはすべてここから作る */
const kanjiNumeralChars = "一二三四五六七八九十百千万億零〇";

/** 続いた漢数字の並び。1 つの並びを 1 つの単位として扱う */
const kanjiSegmentRe = new RegExp(`[${kanjiNumeralChars}]+`, "gu");

const kanjiDigitValues: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  零: 0,
  〇: 0,
};

const kanjiMultipliers: Record<string, number> = {
  億: 100000000,
  万: 10000,
  千: 1000,
  百: 100,
  十: 10,
};

const kanjiDigitValue = (r: string): number | undefined => kanjiDigitValues[r];
const kanjiMultiplier = (r: string): number | undefined => kanjiMultipliers[r];

/**
 * runes[start] から位取り (倍数構造) が始まるか。位の字だけ (十・百・千) か、数字の直後に位の字 (二十)。
 * 数字だけや数字の連続 (一二) は位取りではない。位の字の後の別の字は位取りを止めるだけ (千代は 千 → 1000)
 */
const isPositionStructureStart = (runes: string[], start: number): boolean => {
  const r = runes[start];
  if (kanjiDigitValue(r) !== undefined) {
    if (start + 1 >= runes.length) return false; // 数字だけ
    return kanjiMultiplier(runes[start + 1]) !== undefined;
  }
  return kanjiMultiplier(r) !== undefined;
};

/**
 * runes の start から位取りの漢数字を数にする。[値, 使った文字数] を返し、無ければ [0, 0]。
 * 例: 三百二十三号 → [323, 5]、千二百三 → [1203, 4]、百番地 → [100, 1]、三五十 → [0, 0]
 */
const evalKanjiNumber = (runes: string[], start: number): [number, number] => {
  if (start >= runes.length || !isPositionStructureStart(runes, start)) return [0, 0];

  let result = 0;
  let current = 0;
  let lastWasMultiplier = false;
  let lastMultiplier = 0;
  let wasMultiplierChain = false;
  for (let i = start; i < runes.length; i++) {
    const r = runes[i];
    const d = kanjiDigitValue(r);
    const mult = kanjiMultiplier(r);
    if (d !== undefined) {
      // 位の字の後の数字の次は、位の字でなければならない。数字が続けば位取りではない (百二三)
      if (
        lastWasMultiplier &&
        i + 1 < runes.length &&
        kanjiDigitValue(runes[i + 1]) !== undefined
      ) {
        return [0, 0];
      }
      current = d;
      lastWasMultiplier = false;
      wasMultiplierChain = false;
    } else if (mult !== undefined) {
      // 位の連鎖 (百の後の万) の後に小さい位が来たら、そこで今のまとまりが終わる (千百十一万千百十一)
      if (wasMultiplierChain && mult < lastMultiplier) return [result + current, i - start];
      if ((lastWasMultiplier || current > 0) && lastMultiplier > 0 && mult > lastMultiplier) {
        // 位の連鎖: ここまでの値に大きい位を掛ける (百万 → 100 × 10000)
        result = (result + current) * mult;
        current = 0;
        wasMultiplierChain = true;
      } else {
        result += (current === 0 ? 1 : current) * mult; // 百だけなら 100
        current = 0;
        wasMultiplierChain = false;
      }
      lastWasMultiplier = true;
      lastMultiplier = mult;
    } else {
      return [result + current, i - start]; // 漢数字でない字で止まる
    }
  }
  return [result + current, runes.length - start];
};

/** 1 文字ずつ数にする。漢数字と位の字は数字に、ほかの字はそのまま。位取りになっていない並びに使う */
const kanjiRunesFallback = (runes: string[]): string =>
  runes
    .map((r) => {
      const d = kanjiDigitValue(r);
      if (d !== undefined) return String(d);
      const m = kanjiMultiplier(r);
      return m !== undefined ? String(m) : r;
    })
    .join("");

/**
 * 続いた漢数字の並びを数字にする。頭から位取りが見つかればそこを数にし、残りを同じように処理する。
 * 見つからなければ 1 文字ずつ数にする
 */
const convertKanjiSegment = (seg: string): string => {
  // 万・億だけなら地名の一部で、数ではない。KanjiToArabic が文字列ごとに使う規則を並びごとにも使う
  if (!containsKanjiNumbers(seg)) return seg;

  const runes = Array.from(seg);
  const [value, consumed] = evalKanjiNumber(runes, 0);
  if (consumed === 0) return kanjiRunesFallback(runes);
  if (consumed === runes.length) return String(value);
  // 残りが数だけなら足す (11110000 + 1111 = 11111111)。数でない字を含めばつなげる
  const remainder = convertKanjiSegment(runes.slice(consumed).join(""));
  return /^[+-]?\d+$/.test(remainder)
    ? String(value + Number(remainder))
    : String(value) + remainder;
};

/** 漢数字を数字にする */
export const KanjiToArabic = (s: string): [string, boolean] => {
  if (!containsKanjiNumbers(s)) return [s, false];
  const result = replaceFormalKanji(s).replace(kanjiSegmentRe, convertKanjiSegment);
  return [result, result !== s];
};

/**
 * 漢数字を含むか。万・億は外す。数になる並びは必ず数字か十・百・千を含み、万・億だけなら
 * たいてい地名 (万代町) なので、変換を始めない
 */
const containsKanjiNumbers = (s: string): boolean => Array.from(s).some(IsKanjiNumeral);

/** 漢数字の文字列を数字の文字列にする。kanjiNoToHyphen が使う */
const kanjiPartToArabic = (s: string): string => {
  const runes = Array.from(s);
  const [value, consumed] = evalKanjiNumber(runes, 0);
  // 全体が漢数字の並びでなければ 1 文字ずつ
  return consumed === runes.length && consumed > 0 ? String(value) : kanjiRunesFallback(runes);
};

// 漢数字 + ノ/の + 漢数字 (例: "二ノ八" → "2-8")。文字クラスは kanjiSegmentRe と同じで千・万も含む (千五ノ三)
const kanjiNoKanjiPattern = new RegExp(
  `([${kanjiNumeralChars}]+)[のノ]([${kanjiNumeralChars}]+)`,
  "gu",
);
// 数字 + ノ/の + 漢数字。連なりの続き (例: 1 回目で "二ノ八" → "2-8" の後の "8ノ一" → "8-1")
const arabicNoKanjiPattern = new RegExp(`(\\d+)[のノ]([${kanjiNumeralChars}]+)`, "gu");
// 数字 + ノ/の + 数字。変換しきった "2ノ8ノ1" や途中の "1-2ノ3-4"
const arabicNoArabicPattern = /(\d+)[のノ](\d+)/gu;

// の/ノ の両側の漢数字と数字の組み合わせを全部覆う。kanjiPartToArabic は数字をそのまま通すので、
// 3 つとも同じ置き換えでよい
const noPatterns = [kanjiNoKanjiPattern, arabicNoKanjiPattern, arabicNoArabicPattern];

/** ノかので 2 つに分ける。分けられなければ右は空 */
const splitByNo = (s: string): [string, string] => {
  for (const sep of ["ノ", "の"]) {
    const i = s.indexOf(sep);
    if (i >= 0) return [s.slice(0, i), s.slice(i + sep.length)];
  }
  return [s, ""];
};

/** 「数 の/ノ 数」1 つを数字とハイフンにする */
const noPairToHyphen = (match: string): string => {
  const [left, right] = splitByNo(match);
  return right === "" ? match : `${kanjiPartToArabic(left)}-${kanjiPartToArabic(right)}`;
};

/**
 * 漢数字 + ノ/の + 漢数字 を数字とハイフンにする。例: "二ノ八ノ一" → "2-8-1"、"十二ノ三" → "12-3"。
 * AddressNumbersToHyphen は ASCII の数字が無いと何もしないので、それより先に流す
 */
export const kanjiNoToHyphen = (s: string): [string, boolean] => {
  if (!s.includes("の") && !s.includes("ノ")) return [s, false];
  arabicNoArabicPattern.lastIndex = 0;
  if (!containsKanjiNumbers(s) && !arabicNoArabicPattern.test(s)) return [s, false];

  // 1 回で連なりの 1 つずつしか変わらないので、変わらなくなるまで繰り返す ("二ノ八ノ一" → "2-8ノ一" → "2-8-1")
  const pass = (t: string) => noPatterns.reduce((acc, p) => acc.replace(p, noPairToHyphen), t);
  let cur = replaceFormalKanji(s);
  for (let next = pass(cur); next !== cur; next = pass(cur)) cur = next;
  return [cur, cur !== s];
};
