// 上流には無い。住所の頭の郵便番号 (「〒102-0094 」「102-0094」) を外す。
// 残すと都道府県が読めず、答えが出ない
const POSTAL = /^\s*(〒\s*)?[0-9０-９]{3}\s*[-－‐ー−]?\s*[0-9０-９]{4}(?![0-9０-９])\s*/;

export const stripPostalCode = (address: string): string => address.replace(POSTAL, "");
