// abrg/internal/transform/chome.go の写し (upstream/UPSTREAM のコミット)

const chomePattern = /(\d+)丁目/g;

/** 「数字丁目」を「数字@」にする。例: "栄町1丁目" → "栄町1@" */
export const ChomeToSymbol = (s: string): [string, boolean] => {
  if (!s.includes("丁目")) return [s, false];
  const result = s.replace(chomePattern, "$1@");
  return [result, result !== s];
};
