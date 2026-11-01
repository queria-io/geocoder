// abrg/internal/normalize/quote.go の写し
const strip = (s: string, q: string): string =>
  s.length >= 2 && s.startsWith(q) && s.endsWith(q) ? s.slice(1, -1) : s;

/** 全体を囲む "..." を外し、そのあと '...' も外す */
export const removeQuotes = (s: string): [string, boolean] => {
  if (s.length < 2) return [s, false];
  const result = strip(strip(s, '"'), "'");
  return [result, result !== s];
};
