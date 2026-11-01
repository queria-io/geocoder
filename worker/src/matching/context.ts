// abrg/internal/matching/context.go の写し (upstream/UPSTREAM のコミット)
import type { Category, MatchedResult, NormalizeCategory } from "../model/model";
import type { ParsedAddress } from "./parsed_addr";

/** 当て方の途中で変わらない入力 */
export type NormalizeInput = {
  NormalizedAddr: string;
  SearchAddr: ParsedAddress;
  Pref: string;
  Limit: number;
  Category: Category;
  AddressType: NormalizeCategory;
};

/** 当て方の途中で書き換わる状態 */
export type NormalizeState = {
  LgCode: string;
  MachiazaID: string;
  BasicResults: MatchedResult[];
  UsedLevenshtein: boolean;
  /** あいまい一致をもう流さない (流し終えた、または呼び手が要らないと言った) */
  SkipLevenshtein: boolean;
};

export type NormalizeContext = { Input: NormalizeInput; State: NormalizeState };
