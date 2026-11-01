// abrg/internal/transform/text.go の写し (upstream/UPSTREAM のコミット)
import { NormalizeDashes } from "../normalize/dash";
import { RemoveDefaultIgnorable } from "../normalize/default_ignorable";
import { NFKCNormalize } from "../normalize/nfkc";
import { ApplySteps, type TransformStep } from "../normalize/pipeline";
import { NormalizeSpaces } from "../normalize/whitespace";
import { RemoveOazaAza } from "../util/address";
import { ChomeToSymbol } from "./chome";
import { AddColon } from "./colon";
import { hiraganaToKatakana } from "./kana";
import { KanjiToArabic, kanjiNoToHyphen } from "./kanji_numbers";
import { expandSapporoJou } from "./sapporo";
import { StandardizeSpecialChars } from "./special_chars";

// BasicNormalize と StandardizeSpecialChars を通った文字列向け。それらが済ませた段は入れない
const basicNormalizedSteps: TransformStep[] = [
  RemoveOazaAza,
  kanjiNoToHyphen,
  hiraganaToKatakana,
  AddColon,
  KanjiToArabic,
  // expandSapporoJou は KanjiToArabic の後。正規表現が数字にしか当たらない (北3西1) ので、
  // 北三西一 のような漢字は先に 北3西1 にしておく
  expandSapporoJou,
  ChomeToSymbol,
  NormalizeSpaces,
];

// 辞書の行 (大字・町、小字など) 向け。末尾に番号の無い地名なので AddColon は入れない
const dbSteps: TransformStep[] = [
  RemoveDefaultIgnorable,
  StandardizeSpecialChars,
  NFKCNormalize,
  NormalizeDashes,
  RemoveOazaAza,
  hiraganaToKatakana,
  KanjiToArabic,
  ChomeToSymbol,
  NormalizeSpaces,
];

/** BasicNormalize を通った文字列を変換する */
export const TextForBasicNormalized = (s: string): [string, boolean] =>
  s === "" ? [s, false] : ApplySteps(s, basicNormalizedSteps);

/** 辞書の行 (大字・町、小字など) を変換する */
export const TextForDB = (s: string): [string, boolean] =>
  s === "" ? [s, false] : ApplySteps(s, dbSteps);
