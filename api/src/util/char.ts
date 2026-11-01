// abrg/internal/util/char.go の写し (upstream/UPSTREAM のコミット)。transform が使う分だけ
import { IsASCIIDigit } from "../char/char";

const kanjiNumerals = new Set(Array.from("一二三四五六七八九十〇零百千壱弐参肆伍陸漆捌玖拾"));

/** 漢数字 (大字も含む) か。万・億は数字と並ぶときだけ数を表し、単独では地名 (万代町) なので外す */
export const IsKanjiNumeral = (r: string): boolean => kanjiNumerals.has(r);

/** 住所の番号に使う数字か。ASCII・全角の数字と漢数字 */
export const IsAddressNumberRune = (r: string): boolean =>
  IsASCIIDigit(r) || (r >= "０" && r <= "９" && r.length === 1) || IsKanjiNumeral(r);
