import { describe, expect, it } from "vitest";

import { chunks, guessAddressColumn, parseCsv, toCsv } from "../web/csv";

describe("parseCsv", () => {
  it("囲んだ値のカンマ・改行・二重引用符と BOM を扱う", () => {
    expect(parseCsv('﻿名前,住所\r\n"A, B","東京都\n千代田区"\r\n"x""y",大阪\n')).toEqual([
      ["名前", "住所"],
      ["A, B", "東京都\n千代田区"],
      ['x"y', "大阪"],
    ]);
  });

  it("書いて読むと元に戻る", () => {
    const rows = [["a", 'b"c', "d,e"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("guessAddressColumn", () => {
  it("住所らしい見出しを選ぶ", () => {
    expect(guessAddressColumn(["名前", "所在地"])).toBe(1);
    expect(guessAddressColumn(["a", "b"])).toBe(0);
  });
});

describe("chunks", () => {
  it("n 件ずつに分ける", () => {
    expect(chunks([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
});
