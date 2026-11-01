// abrg/internal/matching/levenshtein/rune_levenshtein.go の写し (upstream/UPSTREAM のコミット)

/** 文字 (コードポイント) で数える編集距離 */
export const runeLevenshtein = (a: string, b: string): number =>
  runeLevenshteinFrom(Array.from(a), b);

export const runeLevenshteinFrom = (ra: string[], b: string): number => {
  const rb = Array.from(b);
  if (ra.length === 0) return rb.length;
  if (rb.length === 0) return ra.length;
  let prev = Array.from({ length: rb.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ra.length; i++) {
    const curr = [i];
    for (let j = 1; j <= rb.length; j++) {
      const cost = ra[i - 1] === rb[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[rb.length];
};
