import { describe, expect, it } from "vitest";

import { type FormerCityRow, withFormerCity } from "../src/former_city";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "../src/model/model";
import type { CityResult } from "../src/repository/types";

const pref = (over: Partial<MatchedResult> = {}): MatchedResult => ({
  matched_address: "三重県",
  unmatched_address: ["員弁郡員弁町笠田新田100"],
  match_level: "pref",
  score: 0.3,
  ids: { ...emptyIDs(), lg_code: "240001" },
  structured_address: emptySA(),
  coordinates: [136.5, 34.7],
  machiaza: emptyMachiaza(),
  ...over,
});
const town = (lgCode: string, address: string, score = 1): MatchedResult =>
  pref({
    matched_address: address,
    unmatched_address: null,
    match_level: "machiaza",
    score,
    ids: { ...emptyIDs(), lg_code: lgCode, machiaza_id: "0001000" },
  });
const city = (lgCode: string, name: string): CityResult => ({
  lgCode,
  pref: "三重県",
  county: null,
  city: name,
  ward: null,
  lon: null,
  lat: null,
});
const CITIES = new Map([
  ["242144", city("242144", "いなべ市")],
  ["242055", city("242055", "桑名市")],
]);
const row = (name: string, town_prefix: string, lg_code: string, share = 1): FormerCityRow => ({
  name_key: name.slice(0, 2),
  name,
  town_prefix,
  pref_code: "24",
  lg_code,
  share,
});
const ROWS = [
  row("員弁郡員弁町", "員弁町", "242144"),
  row("員弁町", "員弁町", "242144"),
  row("桑名郡七和村", "七和村", "242055", 0.99),
];
const formers = async (key: string) => ROWS.filter((r) => r.name_key === key);

describe("withFormerCity", () => {
  it("旧町名を今の市に読み替え、旧町名を残した町字名で照合し直す", async () => {
    const asked: string[] = [];
    const got = await withFormerCity(
      pref(),
      "三重県員弁郡員弁町笠田新田100",
      formers,
      (c) => CITIES.get(c),
      async (a) => {
        asked.push(a);
        return a === "三重県いなべ市員弁町笠田新田100"
          ? [town("242144", "三重県いなべ市員弁町笠田新田")]
          : [];
      },
    );
    expect(asked).toEqual(["三重県いなべ市員弁町笠田新田100", "三重県いなべ市笠田新田100"]);
    expect(got.ids.lg_code).toBe("242144");
    expect(got.former_city).toBe(true);
  });

  it("旧村名が町字名に残っていなければ、外した形で当たる", async () => {
    const got = await withFormerCity(
      pref({ unmatched_address: ["桑名郡七和村大字東汰上1"] }),
      "三重県桑名郡七和村大字東汰上1",
      formers,
      (c) => CITIES.get(c),
      async (a) =>
        a === "三重県桑名市大字東汰上1" ? [town("242055", "三重県桑名市大字東汰上")] : [],
    );
    expect(got.ids.lg_code).toBe("242055");
  });

  it("市区町村まで当たった住所と、旧市区町村名でない住所はそのまま", async () => {
    const hit = town("242144", "三重県いなべ市員弁町笠田新田");
    const never = async (): Promise<MatchedResult[]> => {
      throw new Error("照合し直さない");
    };
    expect(
      await withFormerCity(hit, "三重県員弁郡員弁町笠田新田", formers, (c) => CITIES.get(c), never),
    ).toBe(hit);
    const r = pref({ unmatched_address: ["四日市1"] });
    expect(await withFormerCity(r, "三重県四日市1", formers, (c) => CITIES.get(c), never)).toBe(r);
  });

  it("都道府県名の無い住所では、郡の無い町村名を使わない", async () => {
    const r = pref({ match_level: "unknown", ids: emptyIDs(), matched_address: "" });
    const hit = async () => [town("242144", "三重県いなべ市員弁町笠田新田")];
    const lookup = (c: string) => CITIES.get(c);
    expect(await withFormerCity(r, "員弁町笠田新田", formers, lookup, hit)).toBe(r);
    expect(
      (await withFormerCity(r, "員弁郡員弁町笠田新田", formers, lookup, hit)).ids.lg_code,
    ).toBe("242144");
  });

  it("別の都道府県の同じ名前は使わない", async () => {
    const r = pref({ ids: { ...emptyIDs(), lg_code: "250007" }, matched_address: "滋賀県" });
    const got = await withFormerCity(
      r,
      "滋賀県員弁町1",
      formers,
      (c) => CITIES.get(c),
      async () => [town("242144", "三重県いなべ市員弁町")],
    );
    expect(got).toBe(r);
  });
});
