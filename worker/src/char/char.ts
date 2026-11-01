// abrg/internal/char/char.go の写し (upstream/UPSTREAM のコミット)

/** ASCII の数字 ('0'〜'9') か */
export const IsASCIIDigit = (c: string): boolean => c >= "0" && c <= "9" && c.length === 1;

/** 住所の番号に使うカタカナの範囲 (正規表現の文字クラス)。小書きと長音は名前にしか出ないので外す */
export const KatakanaNumberChars = "ア-ン";

export const IsKatakanaNumberChar = (r: string): boolean =>
  r >= "ア" && r <= "ン" && r.length === 1;
