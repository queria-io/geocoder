// abrg/internal/normalize/whitespace.go の写し
// Go の unicode.IsSpace と同じ集合。JS の \s は U+FEFF を含み U+0085 を含まないので使わない
export const isSpace = (ch: string): boolean =>
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(ch);

/** 空白の並びを半角スペース 1 つにし、前後の空白を落とす */
export const NormalizeSpaces = (s: string): [string, boolean] => {
  if (s === "") return [s, false];
  // 1 文字ごとに配列を作り直すと、空白の多い長い入力で 2 乗の時間がかかる (長さの検査はこのあと)
  const words: string[] = [];
  let word = "";
  for (const ch of s) {
    if (!isSpace(ch)) {
      word += ch;
    } else if (word !== "") {
      words.push(word);
      word = "";
    }
  }
  if (word !== "") words.push(word);
  const result = words.join(" ");
  return [result, result !== s];
};
