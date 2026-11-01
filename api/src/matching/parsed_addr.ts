// abrg/internal/matching/parsed_addr.go の写し (upstream/UPSTREAM のコミット)
//
// 検索文字の印 (":" で町名と番号、"@" で丁目、"-" で番号の区切り、空白で建物名) を、名前の付いた欄に分けたもの
//   "港区虎ノ門:1-23-1"   → Base="港区虎ノ門", Numbers=["1","23","1"]
//   "港区虎ノ門1@:6-5"    → Base="港区虎ノ門", Chome="1", Numbers=["6","5"]
//   "上尾市1@南:15-15"    → Base="上尾市", Chome="1", AfterChome="南", Numbers=["15","15"]
import { IsASCIIDigit } from "../char/char";
import { ExtractChomeDigits } from "../util/address";
import { IsParcelNumberPrefix } from "../util/char";
import { cut } from "./unmatched/unmatched";

export type ParsedAddress = {
  Base: string;
  Chome: string;
  HasChome: boolean;
  AfterChome: string;
  Numbers: string[];
  LeadingHyphen: boolean;
  Building: string;
};

const empty = (): ParsedAddress => ({
  Base: "",
  Chome: "",
  HasChome: false,
  AfterChome: "",
  Numbers: [],
  LeadingHyphen: false,
  Building: "",
});

const parseNumbersAndBuilding = (
  afterColon: string,
): Pick<ParsedAddress, "Numbers" | "LeadingHyphen" | "Building"> => {
  const none = { Numbers: [], LeadingHyphen: false, Building: "" };
  if (afterColon === "") return none;
  const LeadingHyphen = afterColon.startsWith("-");
  const rest = LeadingHyphen ? afterColon.slice(1) : afterColon;
  if (rest === "") return none;
  const sp = rest.indexOf(" ");
  const [nums, Building] = sp > 0 ? [rest.slice(0, sp), rest.slice(sp + 1)] : [rest, ""];
  return { Numbers: nums.split("-"), LeadingHyphen, Building };
};

export const parseSearchAddr = (searchAddr: string): ParsedAddress => {
  if (searchAddr === "") return empty();
  const atIdx = searchAddr.indexOf("@");
  if (atIdx > 0) {
    const beforeAt = searchAddr.slice(0, atIdx);
    const afterAt = searchAddr.slice(atIdx + 1);
    const Chome = ExtractChomeDigits(beforeAt);
    const head = {
      ...empty(),
      HasChome: true,
      Chome,
      Base: beforeAt.slice(0, beforeAt.length - Chome.length),
    };
    if (afterAt.startsWith(":")) return { ...head, ...parseNumbersAndBuilding(afterAt.slice(1)) };
    const [before, after, ok] = cut(afterAt, ":");
    if (ok) return { ...head, AfterChome: before, ...parseNumbersAndBuilding(after) };
    if (afterAt.length > 1 && afterAt[0] === "-" && IsASCIIDigit(afterAt[1]))
      return { ...head, ...parseNumbersAndBuilding(afterAt) };
    return head;
  }
  const [Base, afterColon, hasColon] = cut(searchAddr, ":");
  return { ...empty(), Base, ...(hasColon ? parseNumbersAndBuilding(afterColon) : {}) };
};

/** 欄から検索文字に戻す */
export const parsedString = (p: ParsedAddress): string => {
  if (p.Base === "") return "";
  const chome = p.HasChome ? `${p.Chome}@${p.AfterChome}` : "";
  const nums = p.Numbers.length > 0 ? `:${p.LeadingHyphen ? "-" : ""}${p.Numbers.join("-")}` : "";
  const building = p.Building !== "" ? ` ${p.Building}` : "";
  return p.Base + chome + nums + building;
};

/** 町名の末尾に付いた地番の頭の文字 (甲・イなど)。無ければ "" */
export const parcelNumberPrefix = (p: ParsedAddress): string => {
  const runes = Array.from(p.Base);
  const last = runes[runes.length - 1];
  return last !== undefined && IsParcelNumberPrefix(last) ? last : "";
};
