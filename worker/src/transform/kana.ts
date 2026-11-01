// abrg/internal/transform/kana.go の写し (upstream/UPSTREAM のコミット)

// Go の unicode.Hiragana と同じ、Unicode の Hiragana の用字
const hiragana = /\p{Script=Hiragana}/gu;

/** ひらがなをカタカナにする (符号位置を 0x60 ずらす) */
export const hiraganaToKatakana = (s: string): [string, boolean] => {
  const result = s.replace(hiragana, (r) => String.fromCodePoint(r.codePointAt(0)! + 0x60));
  return [result, result !== s];
};
