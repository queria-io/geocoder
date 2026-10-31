// abrg/internal/normalize/normalize.go の写し
import {
  AddressNumbersToHyphen,
  addSpaceAfterFirstArabicNumber,
  addSpaceAfterNumberBeforeJapanese,
} from "./address_hyphen";
import { detectAddressType, type NormalizeCategory } from "./address_type";
import { BasicNormalizeInput } from "./input";
import { addSpacesAroundPunctuation } from "./punctuation";
import { NormalizeSpaces } from "./whitespace";

/** 入力の住所を照合用の形にする。空・長すぎる住所は例外 */
export const NormalizeAddressText = (s: string): [string, NormalizeCategory] =>
  NormalizeBasicNormalized(BasicNormalizeInput(s));

const applyAddressFormatting = (s: string, addressType: NormalizeCategory): string => {
  if (addressType !== "undetermined" && addressType !== "unknown") {
    return AddressNumbersToHyphen(s)[0];
  }
  const tries = [
    AddressNumbersToHyphen,
    addSpaceAfterFirstArabicNumber,
    ...(addressType === "unknown" ? [addSpaceAfterNumberBeforeJapanese] : []),
  ];
  for (const step of tries) {
    const [result, changed] = step(s);
    if (changed) return result;
  }
  return s;
};

/** BasicNormalize 済みの文字列に、番・号のハイフン化と空白の整形をかける */
export const NormalizeBasicNormalized = (input: string): [string, NormalizeCategory] => {
  const cut = input.indexOf("(");
  const addressPart = cut < 0 ? input : input.slice(0, cut);
  const addressType = detectAddressType(addressPart);
  const formatted = NormalizeSpaces(applyAddressFormatting(addressPart, addressType))[0];
  const joined = cut < 0 ? formatted : `${formatted.trim()} (${input.slice(cut + 1)}`;
  return [addSpacesAroundPunctuation(joined)[0].trim(), addressType];
};
