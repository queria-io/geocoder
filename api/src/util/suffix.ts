// abrg/internal/util/suffix.go の写し (upstream/UPSTREAM のコミット)

const trimSuffix = (s: string, suffix: string): string =>
  s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s;

export const StripChomeSuffix = (s: string): string => trimSuffix(trimSuffix(s, "丁目"), "丁");

export const StripGoSuffix = (s: string): string => trimSuffix(trimSuffix(s, "号"), "字");
