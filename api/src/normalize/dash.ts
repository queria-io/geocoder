// abrg/internal/normalize/dash.go の写し
const dashChars = /[‐‑‒–—―−─━➖﹣－⁻₋⁃〜〰]/g;

const katakanaDash = /([\d０-９])ー([\d０-９])/g;

const replaceUntilStable = (s: string, re: RegExp): string => {
  const next = s.replace(re, "$1-$2");
  return next === s ? s : replaceUntilStable(next, re);
};

/** ダッシュの異体を - にそろえる。数字に挟まれた長音記号 ー も - にする */
export const NormalizeDashes = (s: string): [string, boolean] => {
  const dashed = s.replace(dashChars, "-");
  const result = dashed.includes("ー") ? replaceUntilStable(dashed, katakanaDash) : dashed;
  return [result, result !== s];
};
