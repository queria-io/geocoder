// abrg/internal/transform/colon.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit, IsKatakanaNumberChar, KatakanaNumberChars } from "../char/char";
import { ApplyFirstMatch, type ReplaceRule } from "../normalize/pipeline";
import { isHokkaidoSenPattern } from "./hokkaido";
import { hasSapporoJouLead, sapporoJouPattern } from "./sapporo";

// 住所の終わりに来うる文字の範囲。このファイルの文字クラスはすべてここから作る
const kanjiBlockChars = "一-龥";
// カタカナの区画全体。住所の番号に使う範囲より広い
const katakanaBlockChars = "ァ-ヿ";
const nonDigitEndChars = "A-Z" + KatakanaNumberChars + kanjiBlockChars;
const addressEndChars = "\\d" + nonDigitEndChars;
// Go (RE2) の \s は ASCII の空白だけ。JS の \s は Unicode の空白も含むので、同じ集合を書き出す
const s = "\\t\\n\\f\\r ";

const re = (source: string) => new RegExp(source, "gu");

// 丁目 + 漢字の街区名 (例: "4丁目渡辺" や "4丁目渡辺-2")
const chomeKanjiBlockPattern = re(
  `(丁目)([${kanjiBlockChars}]+(?:-[${addressEndChars}]+)*-?)[${s}]*$`,
);

// 丁目 + 漢字の街区名 + 数字 + 号 (例: "4丁目渡辺3号")
const chomeKanjiBlockGoPattern = re(`(丁目)([${kanjiBlockChars}]+)(\\d+)号[${s}]*$`);

// 丁目 + 漢字の街区名 + 号の無い数字 (例: "4丁目渡辺3")。町・数字・空白 (全角も)・ハイフンは除く
const chomeKanjiBlockNumPattern = re(
  `(丁目)([${kanjiBlockChars}]*[^町\\d${s}\\p{Z}\\-])(\\d+)[${s}]*$`,
);

// 丁目 + ハイフン + 番号 (例: "1丁目-5-2")。境目に置かれたハイフンをコロンに替える
const chomeHyphenNumPattern = re(`(丁目)-(\\d+(?:-[${addressEndChars}]+)*-?)[${s}]*$`);

// 末尾の典型的な番号 (123-4、A-20、12-エ-46、漢字の街区 + ハイフンと数字)。
// 全角の空白も ASCII の空白と同じく番号を区切る。カタカナの番号は 1 文字 (チ-1) なので、
// ハイフンの続きを持てるのは 1 文字だけ。長い並びは名前 (ミナトミライ、公団アパ-ト)
const textNumberBoundaryPattern = re(
  `([^\\d${s}\\p{Z}\\-A-Z${KatakanaNumberChars}])` +
    `((?:\\d+|[A-Z]+|[${KatakanaNumberChars}])(?:-[${addressEndChars}]+)*-?` +
    `|[${KatakanaNumberChars}]+|(?:-\\d+))[${s}]*$`,
);

// 1 文字のカタカナの後の数字。上の規則は左にカタカナを取らないので切れない。カタカナは町名の終わり
// (長ガ1317) か地番の頭 (松子セ16) で、どちらも境目はカタカナと数字の間。住所の最初の番号だけに当てる。
// 後ろの数字は部屋や建物の番号で、前のカタカナは名前の終わり (大通リ506、屋敷ノ11)
const katakanaNumberBoundaryPattern = re(
  `^([^\\d]*[^${katakanaBlockChars}\\d][${KatakanaNumberChars}])` +
    `(\\d+(?:-[${addressEndChars}]+)*-?)[${s}]*$`,
);

// 丁目の後にコロンを入れる規則。細かい順に並べ、最初に文字列を変えた規則が勝つ
const chomeRules: ReplaceRule[] = [
  [chomeKanjiBlockGoPattern, "$1:$2-$3"],
  [chomeKanjiBlockNumPattern, "$1:$2-$3"],
  [chomeKanjiBlockPattern, "$1:$2"],
  [chomeHyphenNumPattern, "$1:$2"],
];

const isAddressEndChar = (r: string): boolean =>
  IsASCIIDigit(r) ||
  (r >= "A" && r <= "Z" && r.length === 1) ||
  IsKatakanaNumberChar(r) ||
  (r >= "一" && r <= "龥" && r.length === 1);

/** 小字の「数字街区」を含むか */
const isGaikuPattern = (str: string): boolean => {
  if (!str.includes("街区")) return false;
  const runes = Array.from(str);
  return runes.some(
    (r, i) => r === "街" && runes[i + 1] === "区" && i > 0 && IsASCIIDigit(runes[i - 1]),
  );
};

/**
 * 札幌の略した住所 (例: "北3西1-7") か。コロンは入れない。
 * expandSapporoJou が後で展開し、丁目を書き出してから自分でコロンを入れる
 */
const isSapporoAbbreviation = (str: string): boolean => {
  if (!hasSapporoJouLead(str)) return false;
  sapporoJouPattern.lastIndex = 0;
  return sapporoJouPattern.test(str);
};

/** ":<カタカナ 1 文字>" で終わるか (小字の見込みが高い) */
const isSingleKatakanaColon = (result: string): boolean => {
  const runes = Array.from(result);
  const last = runes.at(-1);
  return last !== undefined && runes.at(-2) === ":" && IsKatakanaNumberChar(last);
};

const lastRune = (str: string): string | undefined => Array.from(str).at(-1);

/** 名前と末尾の番号の間にコロンを入れる。例: "紀尾井町1-3" → "紀尾井町:1-3" */
export const AddColon = (str: string): [string, boolean] => {
  if (str.includes(":")) return [str, false];

  // 住所の終わりに来うる文字で終わっているか
  const trimmed = str.replace(/ +$/u, "");
  const last = lastRune(trimmed);
  if (last !== undefined && !isAddressEndChar(last)) return [str, false];

  // コロンを入れない特別な形
  if (isHokkaidoSenPattern(str) || isGaikuPattern(str) || isSapporoAbbreviation(str)) {
    return [str, false];
  }

  if (str.includes("丁目")) {
    const [result, ok] = ApplyFirstMatch(str, chomeRules);
    if (ok) return [result, true];
  }

  // 数字・英字・カタカナの番号の規則
  const result = str.replace(textNumberBoundaryPattern, "$1:$2");
  const changed = result !== str;
  if (changed && isSingleKatakanaColon(result)) return [str, false]; // 小字の見込みが高いので戻す
  // カタカナの規則は数字で終わる住所にしか当たらないので、名前で終わる住所は 2 回目を省く
  if (!changed && last !== undefined && IsASCIIDigit(last)) {
    const second = str.replace(katakanaNumberBoundaryPattern, "$1:$2");
    return [second, second !== str];
  }
  return [result, changed];
};
