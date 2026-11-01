// abr-geocoder の正規化と変換の試験 (upstream/cases.json) を、写した src/normalize・src/transform で流す
import { describe, expect, it } from "vitest";
import cases from "../upstream/cases.json";
import * as hyphen from "../src/normalize/address_hyphen";
import { detectAddressType } from "../src/normalize/address_type";
import { removeComments } from "../src/normalize/comment";
import { NormalizeDashes } from "../src/normalize/dash";
import { RemoveDefaultIgnorable } from "../src/normalize/default_ignorable";
import { BasicNormalizeInput } from "../src/normalize/input";
import { NFKCNormalize } from "../src/normalize/nfkc";
import { NormalizeAddressText, NormalizeBasicNormalized } from "../src/normalize/normalize";
import { BasicNormalize } from "../src/normalize/pipeline";
import { addSpacesAroundPunctuation } from "../src/normalize/punctuation";
import { removeQuotes } from "../src/normalize/quote";
import { NormalizeSpaces } from "../src/normalize/whitespace";
import { ChomeToSymbol } from "../src/transform/chome";
import { AddColon } from "../src/transform/colon";
import {
  ExtractSenGoSuffix,
  isHokkaidoSenPattern,
  IsSenGoPattern,
} from "../src/transform/hokkaido";
import { hiraganaToKatakana } from "../src/transform/kana";
import { KanjiToArabic, kanjiNoToHyphen } from "../src/transform/kanji_numbers";
import { expandSapporoJou } from "../src/transform/sapporo";
import { StandardizeSpecialChars } from "../src/transform/special_chars";
import { TextForBasicNormalized, TextForDB } from "../src/transform/text";

type Case = Record<string, unknown>;

/** (string) => [string, boolean] の関数。expected と、あれば changed を比べる */
const pairs: Record<string, (s: string) => [string, boolean]> = {
  AddressNumbersToHyphen: hyphen.AddressNumbersToHyphen,
  addSpaceAfterFirstArabicNumber: hyphen.addSpaceAfterFirstArabicNumber,
  addSpaceAfterNumberBeforeJapanese: hyphen.addSpaceAfterNumberBeforeJapanese,
  removeComments,
  NormalizeDashes,
  RemoveDefaultIgnorable,
  NFKCNormalize,
  addSpacesAroundPunctuation,
  removeQuotes,
  NormalizeSpaces,
  ChomeToSymbol,
  AddColon,
  hiraganaToKatakana,
  KanjiToArabic,
  kanjiNoToHyphen,
  expandSapporoJou,
};

/** 上流で want と changed / wantChanged を持つ (string) => [string, boolean] の関数 */
const wants: Record<string, (s: string) => [string, boolean]> = {
  StandardizeSpecialChars,
  TextForBasicNormalized,
  TextForDB,
};

const predicates: Record<string, (s: string) => boolean> = { isHokkaidoSenPattern, IsSenGoPattern };

const errorOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return (e as Error).constructor.name;
  }
};

const check = (func: string, call: string, c: Case) => {
  const input = String(c.input ?? c.address);
  if (call in pairs) {
    const [got, changed] = pairs[call](input);
    expect(got).toBe(c.expected);
    if ("changed" in c) expect(changed).toBe(c.changed);
  } else if (call in wants) {
    const [got, changed] = wants[call](input);
    expect(got).toBe(c.want);
    if ("changed" in c) expect(changed).toBe(c.changed);
    if ("wantChanged" in c) expect(changed).toBe(c.wantChanged);
  } else if (call in predicates) {
    expect(predicates[call](input)).toBe(c.want);
  } else if (call === "ExtractSenGoSuffix") {
    expect(ExtractSenGoSuffix(input)).toEqual([c.wantBase, c.wantSuffix, c.wantFound]);
  } else if (call === "detectAddressType") {
    expect(detectAddressType(input)).toBe(c.expected);
  } else if (call === "BasicNormalizeInput") {
    const want = c.wantErr as { $expr: string } | undefined;
    if (want) expect(errorOf(() => BasicNormalizeInput(input))).toBe(want.$expr);
    else expect(BasicNormalizeInput(input)).toBe(c.want);
  } else if (func === "TestNormalizeBasicNormalized") {
    // 上流は BasicNormalize の結果を NormalizeBasicNormalized に渡す。空・長さの検査は通さない
    expect(NormalizeBasicNormalized(BasicNormalize(input))).toEqual([
      c.expectedAddr,
      c.expectedType,
    ]);
  } else if (call === "NormalizeAddressText") {
    expect(NormalizeAddressText(input)).toEqual([c.expectedAddr, c.expectedType]);
  } else if (call === "BasicNormalize") {
    expect(BasicNormalize(input)).toBe(c.want);
  } else {
    throw new Error(`未対応の試験: ${func} (${call})`);
  }
};

const tables = cases.filter(
  (t) => t.file.startsWith("normalize/") || t.file.startsWith("transform/"),
);

describe.each(tables.map((t) => [`${t.file} ${t.func}`, t] as const))("%s", (_, t) => {
  it.each(
    (t.cases as Case[]).map(
      (c, i) => [typeof c.name === "string" ? c.name : String(i), c] as const,
    ),
  )("%s", (_, c) => check(t.func, t.call ?? "", c));
});
