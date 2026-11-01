// abrg/internal/normalize/pipeline.go の写し (upstream/UPSTREAM のコミット)
import { removeComments } from "./comment";
import { NormalizeDashes } from "./dash";
import { RemoveDefaultIgnorable } from "./default_ignorable";
import { NFKCNormalize } from "./nfkc";
import { removeQuotes } from "./quote";
import { NormalizeSpaces } from "./whitespace";

/** 文字列を変える 1 段。変えたかどうかも返す */
export type TransformStep = (s: string) => [string, boolean];

/** 置き換え規則。表の中の順に当てる。順番も正規化の仕様のうち */
export type ReplaceRule = [re: RegExp, repl: string];

export const applyRules = (s: string, rules: ReplaceRule[]): string =>
  rules.reduce((acc, [re, repl]) => acc.replace(re, repl), s);

/** 最初に s を変えた規則だけを当てる */
export const ApplyFirstMatch = (s: string, rules: ReplaceRule[]): [string, boolean] => {
  for (const [re, repl] of rules) {
    const next = s.replace(re, repl);
    if (next !== s) return [next, true];
  }
  return [s, false];
};

export const ApplySteps = (s: string, steps: TransformStep[]): [string, boolean] =>
  steps.reduce<[string, boolean]>(
    ([acc, changed], step) => {
      const [next, stepChanged] = step(acc);
      return stepChanged ? [next, true] : [acc, changed];
    },
    [s, false],
  );

// BOM のあとの引用符も removeQuotes に見えるよう、RemoveDefaultIgnorable を先に流す
const basicNormalizeSteps: TransformStep[] = [
  RemoveDefaultIgnorable,
  removeQuotes,
  NormalizeSpaces,
  removeComments,
  NFKCNormalize,
  NormalizeDashes,
];

/** 見えない文字・囲みの引用符・コメントを除き、空白を詰め、NFKC とダッシュの正規化をかける */
export const BasicNormalize = (s: string): string =>
  s === "" ? s : ApplySteps(s, basicNormalizeSteps)[0];
