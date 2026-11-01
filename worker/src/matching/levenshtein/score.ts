// abrg/internal/matching/levenshtein/score.go の写し (upstream/UPSTREAM のコミット)

/** 編集距離を 0〜1 の点に。ぴったりの一致 (1.0) と区別するため、あいまい一致は 0.999 で止める */
export const calculateEditDistanceScore = (editDist: number, addressLen: number): number => {
  if (addressLen === 0 || editDist === 0) return 1;
  const score = Math.round(Math.max(0, 1 - editDist / addressLen) * 100) / 100;
  return score >= 1 ? 0.999 : score;
};
