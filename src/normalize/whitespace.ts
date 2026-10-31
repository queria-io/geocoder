// abrg/internal/normalize/whitespace.go の写し
// Go の unicode.IsSpace と同じ集合。JS の \s は U+FEFF を含み U+0085 を含まないので使わない
export const isSpace = (ch: string): boolean =>
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(ch);

/** 空白の並びを半角スペース 1 つにし、前後の空白を落とす */
export const NormalizeSpaces = (s: string): [string, boolean] => {
  if (s === "") return [s, false];
  const result = Array.from(s)
    .reduce<string[]>((words, ch) => {
      if (isSpace(ch)) return words.at(-1) === "" ? words : [...words, ""];
      return words.length === 0 ? [ch] : [...words.slice(0, -1), words.at(-1) + ch];
    }, [])
    .filter((w) => w !== "")
    .join(" ");
  return [result, result !== s];
};
