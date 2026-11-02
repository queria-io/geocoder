// 上流には無い、照合の前の下ごしらえ。
// 上流は最初の空白より後ろを建物名などとして扱うので、空白の位置で住所が切れないようにする

// 住所の頭の郵便番号 (「〒102-0094 」「102-0094」)。残すと都道府県が読めず、答えが出ない
const POSTAL = /^\s*(〒\s*)?[0-9０-９]{3}\s*[-－‐ー−]?\s*[0-9０-９]{4}(?![0-9０-９])\s*/;

export const stripPostalCode = (address: string): string => address.replace(POSTAL, "");

// 最初の数字より前の空白 (「東京都 千代田区 紀尾井町 1-3」)。数字より後ろの空白は建物名との区切りなので残す
export const joinLeadingSpaces = (address: string): string => {
  const trimmed = address.trim();
  const i = trimmed.search(/[0-9０-９]/);
  const head = i < 0 ? trimmed : trimmed.slice(0, i);
  return head.replace(/[\s　]+/g, "") + (i < 0 ? "" : trimmed.slice(i));
};

export const preNormalize = (address: string): string =>
  joinLeadingSpaces(stripPostalCode(address));
