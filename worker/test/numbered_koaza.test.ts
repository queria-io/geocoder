import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { asNumberedKoaza, withNumberedKoaza } from "../src/numbered_koaza";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "福井県福井市西下野町",
  unmatched_address: ["15-12"],
  match_level: "machiaza",
  score: 0.8,
  ids: { ...emptyIDs(), lg_code: "182010", machiaza_id: "0363000" },
  structured_address: emptySA(),
  coordinates: [136.16, 36.06],
  machiaza: emptyMachiaza(),
  ...over,
});

describe("asNumberedKoaza", () => {
  it("頭の番号を小字の番号にする", () => {
    expect(asNumberedKoaza("15-12")).toBe("15字12");
    expect(asNumberedKoaza("74-14-1")).toBe("74字14-1");
    expect(asNumberedKoaza("15")).toBe("15字");
  });

  it("番号で始まらなければ null", () => {
    expect(asNumberedKoaza("字大畑2")).toBeNull();
    expect(asNumberedKoaza("15字12")).toBeNull();
    expect(asNumberedKoaza("")).toBeNull();
  });
});

describe("withNumberedKoaza", () => {
  it("同じ大字・町の「N字」の小字に照合できたら採る", async () => {
    const asked: string[] = [];
    const koaza = result({
      matched_address: "福井県福井市西下野町15字",
      unmatched_address: ["12"],
      match_level: "machiaza_detail",
      score: 1,
      ids: { ...emptyIDs(), lg_code: "182010", machiaza_id: "0363108" },
    });
    const r = await withNumberedKoaza(result({}), async (a) => (asked.push(a), [koaza]));
    expect(asked).toEqual(["福井県福井市西下野町15字12"]);
    expect(r.ids.machiaza_id).toBe("0363108");
    expect(r.score).toBe(0.8);
  });

  it("「N字」の小字が無ければ元の答えのまま", async () => {
    const same = result({ unmatched_address: ["15字12"] });
    const r = await withNumberedKoaza(result({}), async () => [same]);
    expect(r.unmatched_address).toEqual(["15-12"]);
  });

  it("大字・町でない町字や、番号まで当たった住所は再照合しない", async () => {
    let called = false;
    const ask = async () => ((called = true), []);
    await withNumberedKoaza(result({ ids: { ...emptyIDs(), machiaza_id: "0363108" } }), ask);
    await withNumberedKoaza(result({ match_level: "parcel" }), ask);
    expect(called).toBe(false);
  });
});
