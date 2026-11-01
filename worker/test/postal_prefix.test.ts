import { describe, expect, it } from "vitest";

import { stripPostalCode } from "../src/matching/postal_prefix";

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
