// abrg/internal/normalize/punctuation.go の写し

/** 括弧と読点・カンマの前後の空白をそろえる */
export const addSpacesAroundPunctuation = (s: string): [string, boolean] => {
  if (!/[(),、]/.test(s)) return [s, false];
  let out = "";
  let prevSpace = true; // 先頭に空白を入れない
  for (const ch of s) {
    if (ch === "(" || ch === "," || ch === "、") {
      out += (prevSpace ? "" : " ") + ch;
      prevSpace = false;
    } else if (ch === ")") {
      out += ") ";
      prevSpace = true;
    } else if (ch === " ") {
      if (!prevSpace) out += " ";
      prevSpace = true;
    } else {
      out += ch;
      prevSpace = false;
    }
  }
  const result = out.replace(/ +$/, "");
  return [result, result !== s];
};
