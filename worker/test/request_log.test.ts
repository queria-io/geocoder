import { describe, expect, it } from "vitest";

import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import { logEntry, outcomeOf, REQUEST_LOG_STREAM_SCHEMA, sendLog } from "../src/request_log";

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

describe("sendLog", () => {
  const entry = logEntry("geocode", "どこか", []);

  it("送り先と鍵が無ければ送らない", async () => {
    const calls: unknown[] = [];
    const fetcher = (async (...a: unknown[]) => (calls.push(a), new Response())) as typeof fetch;
    await sendLog({ REQUEST_LOG_URL: "https://log.test" }, [entry], fetcher);
    await sendLog({}, [entry], fetcher);
    expect(calls).toHaveLength(0);
  });

  it("鍵を付けて JSON の配列で送る", async () => {
    const calls: [string, RequestInit][] = [];
    const fetcher = (async (url: string, init: RequestInit) => (
      calls.push([url, init]),
      new Response()
    )) as unknown as typeof fetch;
    await sendLog(
      { REQUEST_LOG_URL: "https://log.test", REQUEST_LOG_TOKEN: "t" },
      [entry],
      fetcher,
    );
    expect(calls[0][0]).toBe("https://log.test");
    expect(new Headers(calls[0][1].headers).get("Authorization")).toBe("Bearer t");
    expect(JSON.parse(calls[0][1].body as string)).toEqual([entry]);
  });
});
