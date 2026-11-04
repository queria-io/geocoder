import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { logEntry, outcomeOf, REQUEST_LOG_STREAM_SCHEMA } from "../src/request_log";

const result = (over: Partial<MatchedResult> = {}): MatchedResult => ({
  matched_address: "東京都千代田区紀尾井町1-3",
  unmatched_address: null,
  match_level: "rsdtdsp_rsdt",
  score: 1,
  ids: { ...emptyIDs(), lg_code: "131016", machiaza_id: "0001001" },
  structured_address: emptySA(),
  coordinates: [139.7, 35.6],
  machiaza: emptyMachiaza(),
  ...over,
});

describe("outcomeOf", () => {
  it("照合の結果を分ける", () => {
    expect(outcomeOf([result()])).toBe("ok");
    expect(outcomeOf([])).toBe("none");
    expect(outcomeOf([result({ match_level: "machiaza" })])).toBe("coarse");
    expect(outcomeOf([result({ unmatched_address: ["ビル"] })])).toBe("remainder");
    expect(outcomeOf([result({ candidates: 2 })])).toBe("ambiguous");
  });
});

describe("logEntry", () => {
  it("入力の住所と先頭の結果を書き、列はストリームと同じ", () => {
    const e = logEntry(
      "geocode",
      "紀尾井町1-3ビル",
      [result({ unmatched_address: ["ビル"] })],
      new Date("2026-11-04T00:00:00Z"),
    );
    expect(e).toEqual({
      ts: "2026-11-04T00:00:00.000Z",
      endpoint: "geocode",
      address: "紀尾井町1-3ビル",
      outcome: "remainder",
      match_level: "rsdtdsp_rsdt",
      coordinates_level: "rsdtdsp_rsdt",
      matched_address: "東京都千代田区紀尾井町1-3",
      unmatched_address: "ビル",
      lg_code: "131016",
      machiaza_id: "0001001",
      candidates: 1,
    });
    expect(Object.keys(e)).toEqual(REQUEST_LOG_STREAM_SCHEMA.fields.map((f) => f.name));
  });

  it("結果が無ければ候補は 0", () => {
    expect(logEntry("batch", "どこか", []).candidates).toBe(0);
  });
});
