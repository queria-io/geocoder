import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { splitAzaName, withAzaSkipped } from "../src/skip_aza";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "千葉県柏市藤心",
  unmatched_address: ["葉貫台932-44"],
  match_level: "machiaza",
  score: 0.8,
  ids: { ...emptyIDs(), lg_code: "122173", machiaza_id: "0112000" },
  structured_address: emptySA(),
  coordinates: [140, 35.8],
  machiaza: emptyMachiaza(),
  ...over,
});

describe("splitAzaName", () => {
  it("頭の字の名前と番号に分ける", () => {
    expect(splitAzaName("葉貫台932-44")).toEqual(["葉貫台", "932-44"]);
    expect(splitAzaName("字樋ノ口276・外")).toEqual(["字樋ノ口", "276・外"]);
    expect(splitAzaName("932-44")).toBeNull();
    expect(splitAzaName("舘ノ内甲2427-27")).toEqual(["舘ノ内", "甲2427-27"]);
    expect(splitAzaName("上加茂字加茂が丘7063-163")).toEqual(["上加茂字加茂が丘", "7063-163"]);
    expect(splitAzaName("ビル")).toBeNull();
    expect(splitAzaName("サンハイツ101")).toBeNull();
    expect(splitAzaName("ABCビル3")).toBeNull();
    expect(splitAzaName("樋ノ口276")).toEqual(["樋ノ口", "276"]);
  });
});

describe("withAzaSkipped", () => {
  it("字の名前を外して地番に当て直す", async () => {
    const asked: string[] = [];
    const parcel = result({ match_level: "parcel", unmatched_address: null, score: 1 });
    const r = await withAzaSkipped(result({}), async (a) => (asked.push(a), [parcel]));
    expect(asked).toEqual(["千葉県柏市藤心932-44"]);
    expect(r.match_level).toBe("parcel");
    expect(r.score).toBeCloseTo(0.72);
  });

  it("当て直しても番号に進まなければ元の答え", async () => {
    const r = await withAzaSkipped(result({}), async () => [result({ unmatched_address: ["x"] })]);
    expect(r.unmatched_address).toEqual(["葉貫台932-44"]);
  });

  it("別の町字に当たったものは使わない", async () => {
    const other = result({
      match_level: "parcel",
      ids: { ...emptyIDs(), lg_code: "122173", machiaza_id: "0113000" },
    });
    const r = await withAzaSkipped(result({}), async () => [other]);
    expect(r.match_level).toBe("machiaza");
  });

  it("番号まで当たっている答えは触らない", async () => {
    const r = await withAzaSkipped(result({ match_level: "parcel" }), async () => {
      throw new Error("呼ばない");
    });
    expect(r.match_level).toBe("parcel");
  });
});
