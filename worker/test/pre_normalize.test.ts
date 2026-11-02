import { describe, expect, it } from "vitest";

import { joinLeadingSpaces, preNormalize, stripPostalCode } from "../src/matching/pre_normalize";

describe("stripPostalCode", () => {
  it.each([
    ["〒100-8111 東京都千代田区千代田1-1", "東京都千代田区千代田1-1"],
    ["〒１０２－００９４東京都千代田区紀尾井町1-3", "東京都千代田区紀尾井町1-3"],
    ["102-0094 東京都千代田区紀尾井町1-3", "東京都千代田区紀尾井町1-3"],
    ["1020094 東京都千代田区紀尾井町1-3", "東京都千代田区紀尾井町1-3"],
  ])("%s", (input, expected) => expect(stripPostalCode(input)).toBe(expected));

  it("郵便番号でない頭の数字は残す", () => {
    expect(stripPostalCode("東京都千代田区紀尾井町1-3")).toBe("東京都千代田区紀尾井町1-3");
    expect(stripPostalCode("12345678番地")).toBe("12345678番地");
  });
});

describe("joinLeadingSpaces", () => {
  it.each([
    ["東京都 千代田区 紀尾井町 1-3", "東京都千代田区紀尾井町1-3"],
    ["東京都　千代田区　紀尾井町１－３", "東京都千代田区紀尾井町１－３"],
    [
      "東京都千代田区紀尾井町1-3 東京ガーデンテラス 19F",
      "東京都千代田区紀尾井町1-3 東京ガーデンテラス 19F",
    ],
    [" 東京都 千代田区一番町 ", "東京都千代田区一番町"],
  ])("%s", (input, expected) => expect(joinLeadingSpaces(input)).toBe(expected));
});

describe("preNormalize", () => {
  it("郵便番号を外してから空白をつなぐ", () => {
    expect(preNormalize("〒102-0094 東京都 千代田区 紀尾井町1-3")).toBe(
      "東京都千代田区紀尾井町1-3",
    );
  });
});
