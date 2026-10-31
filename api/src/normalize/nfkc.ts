// abrg/internal/normalize/nfkc.go の写し
export const NFKCNormalize = (s: string): [string, boolean] => {
  const normalized = s.normalize("NFKC");
  return [normalized, normalized !== s];
};
