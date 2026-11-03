// 物差しの CSV の読み書き。住所に「,」「"」や改行が入るので、引用符の中はそのまま読む
type State = { rows: string[][]; row: string[]; cell: string; quoted: boolean; skip: boolean };

const step = (s: State, c: string, next: string | undefined): State => {
  if (s.skip) return { ...s, skip: false };
  if (s.quoted) {
    if (c === '"' && next === '"') return { ...s, cell: s.cell + '"', skip: true };
    if (c === '"') return { ...s, quoted: false };
    return { ...s, cell: s.cell + c };
  }
  if (c === '"') return { ...s, quoted: true };
  if (c === ",") return { ...s, row: [...s.row, s.cell], cell: "" };
  if (c === "\n" || c === "\r")
    return {
      rows: [...s.rows, [...s.row, s.cell]],
      row: [],
      cell: "",
      quoted: false,
      skip: c === "\r" && next === "\n",
    };
  return { ...s, cell: s.cell + c };
};

export const parseCsv = (text: string): string[][] => {
  const chars = Array.from(text);
  const end = chars.reduce((s, c, i) => step(s, c, chars[i + 1]), {
    rows: [],
    row: [],
    cell: "",
    quoted: false,
    skip: false,
  } as State);
  return end.cell !== "" || end.row.length > 0 ? [...end.rows, [...end.row, end.cell]] : end.rows;
};

export const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
