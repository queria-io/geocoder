// abrg/internal/transform/sapporo.go の写し (upstream/UPSTREAM のコミット)
import { AddColon } from "./colon";

// 札幌の「北N西M」「南N東M」は「北N条西M丁目」の略。書き手が残した丁目や、略で丁目の代わりに置いた
// ハイフンも一致に含め、展開で置き換える (2 つ目を足さない)
export const sapporoJouPattern = /([北南])(\d+)([西東])(\d+)(?:丁目|-)?/g;

/** 北・南が出てきて、条がまだ無いときだけ略の形がありうる */
export const hasSapporoJouLead = (s: string): boolean =>
  !s.includes("条") && (s.includes("北") || s.includes("南"));

/** 札幌の略した住所を展開する。例: "北3西1-7" → "北3条西1丁目:7" */
export const expandSapporoJou = (s: string): [string, boolean] => {
  if (!hasSapporoJouLead(s)) return [s, false];
  const result = s.replace(sapporoJouPattern, "$1$2条$3$4丁目");
  if (result === s) return [s, false];
  // 略の形では AddColon が丁目の境目を見つけられない。丁目を書き出したので、ここで印を付ける
  return [AddColon(result)[0], true];
};
