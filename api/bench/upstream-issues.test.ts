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
import { lazyRepository } from "../src/repository/lazy";
import { memoryRepository } from "../src/repository/memory";
import {
  toBasic,
  toCity,
  toPref,
  type CityTableRow,
  type PrefTableRow,
  type TownRow,
} from "../src/repository/town";
import cases from "../upstream/cases.json";

const dir = new URL("./abr/", import.meta.url);
const read = <T>(name: string): T[] => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

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
  const cities = read<CityTableRow>("city.json").map(toCity);
  const prefs = read<PrefTableRow>("pref.json").map(toPref);
  const byCity = Map.groupBy(towns, (t) => t.lgCode);
  // REPO=lazy で、Worker と同じく市区町村ごとに読む形を流す
  const repo =
    process.env.REPO === "lazy"
      ? lazyRepository(async (lg) => byCity.get(lg) ?? [], cities, prefs)
      : memoryRepository(towns, cities, prefs);
  const n = NewMatcher(repo, cities);

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
  writeFileSync(
    new URL(`upstream-results-${process.env.REPO ?? "memory"}.json`, dir),
    JSON.stringify(results, null, 1),
  );
  const count = (scope: string) => {
    const xs = results.filter((r) => r.scope === scope);
    return `${xs.filter((r) => r.ok).length}/${xs.length}`;
  };
  console.log(`町字まで: ${count("town")}  それより細かい: ${count("detail")}`);
  expect(results.length).toBeGreaterThan(0);
});
