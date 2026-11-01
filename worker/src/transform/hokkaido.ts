// abrg/internal/transform/hokkaido.go の写し (upstream/UPSTREAM のコミット)
// 北海道の殖民地割 (「N線M号」) の扱い
import { IsASCIIDigit } from "../char/char";

/** "7線1号" や "10線西5号" を、"N線[方角]" と "M号" に分ける */
const senGoPattern = /^(.*\d+線[東西南北]?)(\d+号)$/u;

/** 「数字+線」で終わるか。例: "7線" は true、"上条" は false */
export const isHokkaidoSenPattern = (s: string): boolean => {
  if (!s.endsWith("線")) return false;
  const prev = Array.from(s.slice(0, -1)).at(-1);
  return prev !== undefined && IsASCIIDigit(prev);
};

/** 「N線:M号」の形か。例: "上川郡鷹栖町7線:1号" は true、"小松市軽海町ノ:14-1" は false */
export const IsSenGoPattern = (addr: string): boolean => {
  const i = addr.indexOf(":");
  if (i < 0) return false;
  const before = addr.slice(0, i);
  const after = addr.slice(i + 1);
  if (after === "" || !before.endsWith("線")) return false;
  return after.split("-")[0].endsWith("号");
};

/** 殖民地割の住所から「M号」を取り出す。例: "上川郡鷹栖町7線1号" → ["上川郡鷹栖町7線", "1号", true] */
export const ExtractSenGoSuffix = (
  address: string,
): [base: string, suffix: string, found: boolean] => {
  const m = senGoPattern.exec(address);
  return m ? [m[1], m[2], true] : ["", "", false];
};
