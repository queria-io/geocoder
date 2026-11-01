// abrg/internal/normalize/default_ignorable.go の写し
const defaultIgnorable: [number, number][] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];

const isDefaultIgnorable = (ch: string): boolean => {
  const cp = ch.codePointAt(0) ?? 0;
  return defaultIgnorable.some(([lo, hi]) => cp >= lo && cp <= hi);
};

export const RemoveDefaultIgnorable = (s: string): [string, boolean] => {
  const chars = Array.from(s);
  if (!chars.some(isDefaultIgnorable)) return [s, false];
  return [chars.filter((ch) => !isDefaultIgnorable(ch)).join(""), true];
};
