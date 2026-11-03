import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { withOazaChome } from "../src/oaza_chome";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "埼玉県入間市大字扇町屋",
  unmatched_address: ["1-9-34"],
  match_level: "machiaza",
  score: 1,
  ids: { ...emptyIDs(), lg_code: "112259", machiaza_id: "0002000" },
  structured_address: { ...emptySA(), oaza_cho: "大字扇町屋" },
  coordinates: [139.39, 35.83],
  machiaza: emptyMachiaza(),
  ...over,
});
const chome = result({
  matched_address: "埼玉県入間市扇町屋一丁目9-34",
  unmatched_address: null,
  match_level: "rsdtdsp_rsdt",
  ids: { ...emptyIDs(), lg_code: "112259", machiaza_id: "0005001" },
  structured_address: { ...emptySA(), oaza_cho: "扇町屋", chome: "一丁目" },
});

describe("withOazaChome", () => {
  it("大字を書かない住所は、大字を外した名前の丁目で当て直す", async () => {
    const asked: string[] = [];
    const r = await withOazaChome(result({}), "埼玉県入間市扇町屋1-9-34", async (a) => {
      asked.push(a);
      return [chome];
    });
    expect(asked).toEqual(["埼玉県入間市扇町屋1丁目9-34"]);
    expect(r.ids.machiaza_id).toBe("0005001");
  });

  it("頭に 0 の付く番号 (「01-9-34」) も同じ丁目と見る", async () => {
    const r = await withOazaChome(
      result({ unmatched_address: ["01-9-34"] }),
      "埼玉県入間市扇町屋01-9-34",
      async () => [chome],
    );
    expect(r.ids.machiaza_id).toBe("0005001");
  });

  it("丁目の町で地番に当たらなくても、残りが番号から始まれば丁目の答えを使う", async () => {
    const parent = result({
      matched_address: "埼玉県入間市扇町屋一丁目",
      unmatched_address: ["224"],
      ids: { ...emptyIDs(), lg_code: "112259", machiaza_id: "0005001" },
      structured_address: { ...emptySA(), oaza_cho: "扇町屋", chome: "一丁目" },
    });
    const r = await withOazaChome(
      result({ unmatched_address: ["1-224"] }),
      "埼玉県入間市扇町屋1-224",
      async () => [parent],
    );
    expect(r.ids.machiaza_id).toBe("0005001");
  });

  it("「大字」と書いた住所・丁目に当たらなかったものはそのまま", async () => {
    const r = result({});
    expect(await withOazaChome(r, "埼玉県入間市大字扇町屋1-9-34", async () => [chome])).toBe(r);
    expect(await withOazaChome(r, "埼玉県入間市扇町屋1-9-34", async () => [r])).toBe(r);
    // 「5丁目」が無くて似た名前の別の丁目に当たったものは使わない
    const five = result({ unmatched_address: ["5-9-34"] });
    expect(await withOazaChome(five, "埼玉県入間市扇町屋5-9-34", async () => [chome])).toBe(five);
    const one = result({ unmatched_address: ["72"] });
    expect(await withOazaChome(one, "埼玉県入間市扇町屋72", async () => [chome])).toBe(one);
  });
});
