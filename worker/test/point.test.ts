import { describe, expect, it } from "vitest";

import { parentNumber, withAddressPoint, type PointRow } from "../src/point";
import type { BasicResult } from "../src/repository/types";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";

const result = (over: Partial<MatchedResult>): MatchedResult => ({
  matched_address: "茨城県つくば市学園南3丁目",
  unmatched_address: ["28-10"],
  match_level: "machiaza_detail",
  score: 1,
  ids: { ...emptyIDs(), lg_code: "082201", machiaza_id: "0051003" },
  structured_address: emptySA(),
  coordinates: [140.08913, 36.077563],
  machiaza: emptyMachiaza(),
  ...over,
});

const pt = (num1: string, num2: string | null, over: Partial<PointRow> = {}): PointRow => ({
  system: "parcel",
  num1,
  num2,
  num3: null,
  point_type: "parcel_parent",
  source: "isj",
  lng: 140.0891,
  lat: 36.073632,
  ...over,
});

const rows: Record<string, PointRow[]> = {
  "0822010051003": [
    pt("28", null),
    pt("5", null, { system: "rsdt", point_type: "block", lng: 140.1, lat: 36.1 }),
  ],
};
const load = async (lg: string, id: string) => rows[lg + id] ?? [];
const noTown = async () => null;
const townOf = (t: Partial<BasicResult>) => async (): Promise<BasicResult> =>
  ({ machiazaId: "0051003", ...t }) as BasicResult;

describe("withAddressPoint", () => {
  it("町字止まりの地番の住所は親番の点にする", async () => {
    const r = await withAddressPoint(result({}), load, noTown);
    expect(r.coordinates).toEqual([140.0891, 36.073632]);
    expect(r.coordinate_level).toBe("parcel_parent");
  });

  it("住居表示の街区の点は使わない", async () => {
    const r = await withAddressPoint(result({ unmatched_address: ["5-1"] }), load, noTown);
    expect(r.coordinate_level).toBeUndefined();
  });

  it("番号の点まで当たっていれば触らない", async () => {
    const r = await withAddressPoint(result({ match_level: "parcel" }), load, noTown);
    expect(r.coordinates).toEqual([140.08913, 36.077563]);
  });

  it("地番まで当たって点が無く町字の点で埋めたものは、その地番の行の点にする", async () => {
    const own: Record<string, PointRow[]> = {
      "0822010051003": [pt("28", null), pt("28", "10", { lng: 140.3, lat: 36.3 })],
    };
    const r = await withAddressPoint(
      result({
        match_level: "parcel",
        coordinate_level: "machiaza_detail",
        unmatched_address: null,
        structured_address: { ...emptySA(), prc_num1: "28", prc_num2: "10" },
      }),
      async (lg, id) => own[lg + id] ?? [],
      noTown,
    );
    expect(r.coordinates).toEqual([140.3, 36.3]);
    expect(r.coordinate_level).toBe("parcel_parent");
  });

  it("小字が起番でなければ大字・町の区域の点を使う", async () => {
    const base: Record<string, PointRow[]> = { "0822010051000": [pt("28", null, { lng: 140.2 })] };
    const r = await withAddressPoint(
      result({}),
      async (lg, id) => base[lg + id] ?? [],
      townOf({ numberingId: "0051000", parcelUnique: true }),
    );
    expect(r.coordinates?.[0]).toBe(140.2);
  });

  it("区域の中で地番が一意でなければ区域では探さない", async () => {
    const base: Record<string, PointRow[]> = { "0822010051000": [pt("28", null, { lng: 140.2 })] };
    const r = await withAddressPoint(
      result({}),
      async (lg, id) => base[lg + id] ?? [],
      townOf({ numberingId: "0051000", parcelUnique: false }),
    );
    expect(r.coordinate_level).toBeUndefined();
  });

  it("筆の点なら段は parcel", async () => {
    const own: Record<string, PointRow[]> = {
      "0822010051003": [pt("28", null, { point_type: "parcel", source: "abr" })],
    };
    const r = await withAddressPoint(
      result({ unmatched_address: ["28番地"] }),
      async (lg, id) => own[lg + id] ?? [],
      noTown,
    );
    expect(r.coordinate_level).toBe("parcel");
  });

  it("親番の筆の点で埋めたものは段は parcel_parent", async () => {
    const own: Record<string, PointRow[]> = {
      "0822010051003": [pt("28", null, { point_type: "parcel", source: "abr" })],
    };
    const r = await withAddressPoint(result({}), async (lg, id) => own[lg + id] ?? [], noTown);
    expect(r.coordinate_level).toBe("parcel_parent");
  });

  it("町字止まりでも残りの番号の行があればその点を使う", async () => {
    const base: Record<string, PointRow[]> = {
      "0822010051000": [
        pt("28", null, { lng: 140.2 }),
        pt("28", "10", { point_type: "parcel", source: "abr", lng: 140.4 }),
      ],
    };
    const r = await withAddressPoint(
      result({ unmatched_address: ["28番地10"] }),
      async (lg, id) => base[lg + id] ?? [],
      townOf({ numberingId: "0051000", parcelUnique: true }),
    );
    expect(r.coordinates?.[0]).toBe(140.4);
    expect(r.coordinate_level).toBe("parcel");
  });

  it("28-10-3 に点が無ければ 28-10 の点、それも無ければ 28 の点にする", async () => {
    const withMid: Record<string, PointRow[]> = {
      "0822010051003": [pt("28", null), pt("28", "10", { lng: 140.3 })],
    };
    const mid = await withAddressPoint(
      result({ unmatched_address: ["28-10-3"] }),
      async (lg, id) => withMid[lg + id] ?? [],
      noTown,
    );
    expect(mid.coordinates?.[0]).toBe(140.3);
    expect(mid.coordinate_level).toBe("parcel_parent");
    const top = await withAddressPoint(result({ unmatched_address: ["28-10-3"] }), load, noTown);
    expect(top.coordinates?.[0]).toBe(140.0891);
  });
});

describe("parentNumber", () => {
  it("残りの頭の数字", () => {
    expect(parentNumber(result({ unmatched_address: ["28-10"] }))).toBe("28");
    expect(parentNumber(result({ unmatched_address: ["28番地10"] }))).toBe("28");
    expect(parentNumber(result({ unmatched_address: ["ビル"] }))).toBeNull();
    expect(parentNumber(result({ unmatched_address: ["2F"] }))).toBeNull();
    expect(parentNumber(result({ unmatched_address: ["9丁目28"] }))).toBeNull();
  });
});
