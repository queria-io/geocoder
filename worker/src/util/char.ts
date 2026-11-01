// abrg/internal/util/char.go の写し (upstream/UPSTREAM のコミット)
import { IsASCIIDigit, IsKatakanaNumberChar } from "../char/char";

const kanjiNumerals = new Set(Array.from("一二三四五六七八九十〇零百千壱弐参肆伍陸漆捌玖拾"));

/** 漢数字 (大字も含む) か。万・億は数字と並ぶときだけ数を表し、単独では地名 (万代町) なので外す */
export const IsKanjiNumeral = (r: string): boolean => kanjiNumerals.has(r);

/** 住所の番号に使う数字か。ASCII・全角の数字と漢数字 */
export const IsAddressNumberRune = (r: string): boolean =>
  IsASCIIDigit(r) || (r >= "０" && r <= "９" && r.length === 1) || IsKanjiNumeral(r);

const parcelNumberPrefixes = new Set(Array.from("甲乙丙丁戊己庚辛壬癸子丑寅卯夘辰巳午未申酉戌亥"));

/** 地番の頭に付く文字か。十干・十二支と、イロハの番号に使うカタカナ */
export const IsParcelNumberPrefix = (r: string): boolean =>
  parcelNumberPrefixes.has(r) || IsKatakanaNumberChar(r);

const katakanaToHiraganaOffset = "ア".charCodeAt(0) - "あ".charCodeAt(0);

export const KatakanaToHiragana = (s: string): string =>
  Array.from(s, (r) =>
    IsKatakanaNumberChar(r) ? String.fromCharCode(r.charCodeAt(0) - katakanaToHiraganaOffset) : r,
  ).join("");

/** 地番の頭のイロハは ABR がカタカナとひらがなの両方で書くので、両方の書き方を返す */
export const KanaSpellings = (s: string): string[] => {
  const hiragana = KatakanaToHiragana(s);
  return hiragana !== s ? [s, hiragana] : [s];
};
