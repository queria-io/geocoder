// abrg/internal/normalize/comment.go の写し
const blockComment = /\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\//g; // /* ... */
const lineComment = /\/\/.*/g; // // ...

export const removeComments = (s: string): [string, boolean] => {
  if (!s.includes("/")) return [s, false];
  const result = s.replace(blockComment, "").replace(lineComment, "").replace(/ +$/, "");
  return [result, result !== s];
};
