// 上流が使う DuckDB の editdist3 (= levenshtein) と同じ距離。DuckDB は UTF-8 のバイトで数えるので、こちらもバイトで数える
const encoder = new TextEncoder();

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export const byteLength = (s: string): number => utf8(s).length;

export const editdist3 = (a: Uint8Array, b: Uint8Array): number => {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
};
