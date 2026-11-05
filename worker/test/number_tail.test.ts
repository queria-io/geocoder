import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { remainder, splitNumberTail, withNumberTail } from "../src/number_tail";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "愛知県名古屋市南区中割町四丁目",
  unmatched_address: ["88プレザンメゾン笠寺"],
  match_level: "machiaza_detail",
  score: 0.8,
  ids: { ...emptyIDs(), lg_code: "231126", machiaza_id: "0071004" },
  structured_address: emptySA(),
  coordinates: [136.92, 35.09],
  machiaza: emptyMachiaza(),
  ...over,
});

describe("splitNumberTail", () => {
  it("番号の並びを「-」でつなぎ、後ろを空白で分ける", () => {
    expect(splitNumberTail("88プレザンメゾン笠寺")).toBe("88 プレザンメゾン笠寺");
    expect(splitNumberTail("28街区28号")).toBe("28-28");
    expect(splitNumberTail("25区486番")).toBe("25-486");
    expect(splitNumberTail("15号5 外")).toBe("15-5 外");
    expect(splitNumberTail("4愛の家グループホーム岐阜")).toBe("4 愛の家グループホーム岐阜");
    expect(splitNumberTail("5の3")).toBe("5-3");
    expect(splitNumberTail("5番地の1")).toBe("5-1");
    expect(splitNumberTail("8ー2ビル")).toBe("8-2 ビル");
  });

  it("書き直すところが無ければ null", () => {
    expect(splitNumberTail("12-3")).toBeNull();
    expect(splitNumberTail("ビル")).toBeNull();
    expect(splitNumberTail("")).toBeNull();
    expect(splitNumberTail("16地割5番地")).toBeNull();
  });
});

describe("remainder", () => {
  it("照合できなかった部分が空なら、丁目の後ろの番号から読む", () => {
    const empty = result({ unmatched_address: null });
    expect(remainder(empty, "中割町4丁目88プレザンメゾン笠寺")).toBe("88プレザンメゾン笠寺");
    expect(remainder(empty, "粟野東５丁目４愛の家")).toBe("4愛の家");
    expect(remainder(empty, "中割町4丁目")).toBe("");
    expect(remainder(empty, "中割町")).toBe("");
    expect(remainder(result({}), "")).toBe("88プレザンメゾン笠寺");
  });
});

describe("withNumberTail", () => {
  it("同じ町字で番号まで進んだら採る", async () => {
    const asked: string[] = [];
    const parcel = result({ match_level: "parcel", unmatched_address: null, score: 1 });
    const r = await withNumberTail(result({}), "", async (a) => (asked.push(a), [parcel]));
    expect(asked).toEqual(["愛知県名古屋市南区中割町四丁目88 プレザンメゾン笠寺"]);
    expect(r.match_level).toBe("parcel");
    expect(r.score).toBe(0.8);
  });

  it("別の町字や町字止まりなら元の答えのまま", async () => {
    const other = result({ match_level: "parcel", ids: { ...emptyIDs(), machiaza_id: "9" } });
    const before = result({});
    expect(await withNumberTail(before, "", async () => [other])).toBe(before);
    expect(await withNumberTail(before, "", async () => [result({})])).toBe(before);
  });
});
