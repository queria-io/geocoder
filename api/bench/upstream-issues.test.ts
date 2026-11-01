// 上流の matching/issues の試験 (upstream/cases.json) を、ABR の町字までの表で流す。
// 住居表示と地番の段はまだ無いので、町字より細かい答えを期待する試験は数えるだけにする。
//
//   uv run --with duckdb python bench/make-abr-fixture.py <ABR の CSV のフォルダ> bench/abr/
//   pnpm exec vitest run --config bench/vitest.config.ts
//
// 結果は bench/abr/upstream-results.json に書く
import { readFileSync, writeFileSync } from "node:fs";

import { expect, test } from "vitest";

import { Match } from "../src/matching/match_core";
import { NewMatcher } from "../src/matching/matcher";
import type { Category, MatchedResult } from "../src/model/model";
import { memoryRepository, type CityRow, type PrefRow } from "../src/repository/memory";
import type { BasicResult } from "../src/repository/types";
import { TextForDB } from "../src/transform/text";
import cases from "../upstream/cases.json";

type TownRow = {
  lg_code: string;
  machiaza_id: string;
  pref_name: string;
  county_name: string | null;
  city_name: string;
  ward_name: string | null;
  oaza_cho: string | null;
  chome: string | null;
  koaza: string | null;
  kyoto_street: boolean;
  machiaza_dist: string | null;
  has_chome: boolean;
  rsdt_addr_flg: string;
  rsdt_addr_partial: boolean;
};

const dir = new URL("./abr/", import.meta.url);
const read = <T>(name: string): T[] => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

/** town の 1 行を上流の cache_machiaza の 1 行に (京都の通り名は koaza から kyoto_st へ移す) */
const toBasic = (t: TownRow): BasicResult => {
  const kyotoSt = t.kyoto_street ? t.koaza : null;
  const koaza = t.kyoto_street ? null : t.koaza;
  const parts = [t.county_name, t.city_name, t.ward_name, kyotoSt, t.oaza_cho, t.chome, koaza];
  return {
    normalizedAddress: TextForDB(parts.map((p) => p ?? "").join(""))[0],
    lgCode: t.lg_code,
    machiazaId: t.machiaza_id,
    rsdtAddrFlg: t.rsdt_addr_partial ? null : t.rsdt_addr_flg,
    pref: t.pref_name,
    county: t.county_name,
    city: t.city_name,
    ward: t.ward_name,
    kyotoSt,
    oazaCho: t.oaza_cho,
    chome: t.chome,
    koaza,
    machiazaDist: t.machiaza_dist,
    hasChome: t.has_chome,
    parcelCount: 0,
    rsdtdspCount: 0,
    lon: null,
    lat: null,
  };
};

type Expect = {
  name: string;
  query: { Address: string; Category?: unknown; Limit?: number; Pref?: string };
  wantMatchLevel?: string;
  wantMatchedAddress?: string;
  wantUnmatchedAddress?: string[] | null;
  wantStructured?: Record<string, string | null>;
};

const townLevels = new Set(["pref", "city", "machiaza", "machiaza_detail", "unknown"]);

const category = (c: unknown): Category =>
  typeof c === "string" && c !== "" ? (c as Category) : "all";

/** 上流の runNormalizeTests と同じ比べ方。食い違いを文で返す */
const diff = (want: Expect, got: MatchedResult | undefined): string[] => {
  if (got === undefined) return ["no results"];
  const out: string[] = [];
  if (want.wantMatchLevel && got.match_level !== want.wantMatchLevel)
    out.push(`match_level = ${got.match_level}, want ${want.wantMatchLevel}`);
  if (want.wantMatchedAddress && got.matched_address !== want.wantMatchedAddress)
    out.push(`matched_address = ${got.matched_address}, want ${want.wantMatchedAddress}`);
  const gotU = got.unmatched_address ?? [];
  const wantU = want.wantUnmatchedAddress;
  if (
    wantU == null
      ? gotU.length > 0
      : wantU.length > 0 && JSON.stringify(gotU) !== JSON.stringify(wantU)
  )
    out.push(`unmatched = ${JSON.stringify(gotU)}, want ${JSON.stringify(wantU ?? [])}`);
  for (const [k, v] of Object.entries(want.wantStructured ?? {})) {
    const g = got.structured_address[k as keyof MatchedResult["structured_address"]];
    if (g !== v) out.push(`${k} = ${JSON.stringify(g)}, want ${JSON.stringify(v)}`);
  }
  return out;
};

test("上流の matching/issues", async () => {
  const towns = read<TownRow>("town.json").map(toBasic);
  const cityRows = read<{
    lg_code: string;
    pref_code: string;
    pref_name: string;
    county_name: string | null;
    city_name: string;
    ward_name: string | null;
  }>("city.json");
  const cities: CityRow[] = cityRows.map((c) => ({
    lgCode: c.lg_code,
    prefCode: c.pref_code,
    pref: c.pref_name,
    county: c.county_name,
    city: c.city_name,
    ward: c.ward_name,
    lon: null,
    lat: null,
    normalizedAddress: TextForDB((c.county_name ?? "") + c.city_name + (c.ward_name ?? ""))[0],
  }));
  const prefs: PrefRow[] = read<{ lg_code: string; pref_code: string; pref_name: string }>(
    "pref.json",
  ).map((p) => ({ lgCode: p.lg_code, prefCode: p.pref_code, prefName: p.pref_name }));
  const n = NewMatcher(memoryRepository(towns, cities, prefs), cities);

  const all = (cases as { file: string; cases: Expect[] }[])
    .filter((t) => t.file.startsWith("matching/issues/"))
    .flatMap((t) => t.cases.map((c) => ({ ...c, file: t.file })))
    .filter(
      (c) => typeof c.query === "object" && c.query !== null && typeof c.query.Address === "string",
    );

  const results = [];
  for (const c of all) {
    const scope =
      c.wantMatchLevel === undefined || townLevels.has(c.wantMatchLevel) ? "town" : "detail";
    const got = await Match(n, {
      address: c.query.Address,
      category: category(c.query.Category),
      pref: c.query.Pref ?? "",
      limit: c.query.Limit ?? 1,
    }).catch((e: unknown) => e as Error);
    const problems = got instanceof Error ? [`error: ${got.message}`] : diff(c, got[0]);
    results.push({
      file: c.file,
      name: c.name,
      address: c.query.Address,
      scope,
      ok: problems.length === 0,
      problems,
    });
  }
  writeFileSync(new URL("upstream-results.json", dir), JSON.stringify(results, null, 1));
  const count = (scope: string) => {
    const xs = results.filter((r) => r.scope === scope);
    return `${xs.filter((r) => r.ok).length}/${xs.length}`;
  };
  console.log(`町字まで: ${count("town")}  それより細かい: ${count("detail")}`);
  expect(results.length).toBeGreaterThan(0);
});
