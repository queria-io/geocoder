// abrg/internal/normalize/address_type.go の写し

/** 住所の書き方の種類。値は abr-geocoder の model.NormalizeCategory と同じ */
export type NormalizeCategory = "rsdtdsp" | "parcel" | "undetermined" | "unknown";

const patternBanchiGo = /\d+番地\d+(?:-\d+)*号/;
const patternBanGo = /\d+番\d+(?:-[A-Za-z0-9]+)*号/;
const patternBan = /\d+番\d+$/;
const patternBanOnly = /\d+番$/;
const patternBanchi = /\d+番地/;
const patternArabicDash = /\d+-\d+/;

/** 最初の空白より前を見て、住居表示か地番か決まらないかを判定する */
export const detectAddressType = (address: string): NormalizeCategory => {
  const s = address.split(" ")[0];
  if (patternBanchiGo.test(s)) return "undetermined";
  if (patternBanGo.test(s)) return "rsdtdsp";
  if (patternBan.test(s) || patternBanOnly.test(s)) return "undetermined";
  if (patternBanchi.test(s)) return "parcel";
  if (patternArabicDash.test(s)) return "undetermined";
  return "unknown";
};
