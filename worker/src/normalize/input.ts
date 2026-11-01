// abrg/internal/normalize/input.go の写し
import { BasicNormalize } from "./pipeline";

export const MaxAddressLength = 100;

export class ErrEmptyAddress extends Error {
  constructor() {
    super("address cannot be empty");
  }
}

export class ErrAddressTooLong extends Error {
  constructor() {
    super(`address too long: max ${MaxAddressLength} characters`);
  }
}

/** BasicNormalize のあと、空と長すぎる住所を弾く */
export const BasicNormalizeInput = (s: string): string => {
  const out = BasicNormalize(s);
  if (out === "") throw new ErrEmptyAddress();
  if (Array.from(out).length > MaxAddressLength) throw new ErrAddressTooLong();
  return out;
};
