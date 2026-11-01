// 上流の matching/issues の試験 (upstream/cases.json) を、ABR から作った表で流す。
// 地番の段はまだ無いので、地番を期待する試験は数えるだけにする。
//
//   uv run --with duckdb python bench/make-abr-fixture.py <ABR の CSV のフォルダ> bench/abr/ [rsdtdsp の Parquet]
//   pnpm exec vitest run --config bench/vitest.config.ts
//
// 結果は bench/abr/upstream-results.json に書く
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { asyncBufferFromFile } from "hyparquet";

import { expect, test } from "vitest";

import { Match } from "../src/matching/match_core";
import { NewMatcher } from "../src/matching/matcher";
import type { Category, MatchedResult } from "../src/model/model";
import { lazyRepository } from "../src/repository/lazy";
import { openTable, readWhere } from "../src/data/parquet";
import { memoryRepository } from "../src/repository/memory";
import {
  findResidentialBestMatch,
  machiazaKey,
  RSDTDSP_COLUMNS,
  type RsdtdspRow,
} from "../src/repository/rsdtdsp";
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

/**
 * 上流と意図して答えを変えた試験。上流は「○丁」まで当たった町字でも最初の番号を丁目と読み替えるので、
 * データにある番・号まで届かない。こちらは読み替えずに当てる (src/matching/two_stage.ts)
 */
const intended = new Map([
  ["jat075", "宿院町西2丁 1番1号まで当てる (上流は 1番まで)"],
  ["nja048-1", "向陵西町2丁 1番26号まで当てる (上流は町字まで)"],
]);

const townLevels = new Set(["pref", "city", "machiaza", "machiaza_detail", "unknown"]);
const scopeOf = (level: string | undefined): string =>
  level === undefined || townLevels.has(level)
    ? "town"
    : level.startsWith("rsdtdsp")
      ? "residential"
      : "parcel";

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
  // 住居表示の表 (2 千万行) はメモリに載せず、Worker と同じく町字ごとに Parquet から読む
  const rsdtdspFile = new URL("rsdtdsp.parquet", dir);
  const rsdtdsp = existsSync(rsdtdspFile)
    ? await openTable(await asyncBufferFromFile(rsdtdspFile.pathname))
    : null;
  const loadMachiaza = async (lg: string, id: string): Promise<RsdtdspRow[]> =>
    rsdtdsp ? readWhere(rsdtdsp, "machiaza_key", machiazaKey(lg, id), RSDTDSP_COLUMNS) : [];
  // REPO=lazy で、Worker と同じく市区町村ごとに読む形を流す
  const repo =
    process.env.REPO === "lazy"
      ? lazyRepository(async (lg) => byCity.get(lg) ?? [], cities, prefs, loadMachiaza)
      : {
          ...memoryRepository(towns, cities, prefs),
          FindResidentialBestMatch: async (
            lg: string,
            id: string,
            f: Parameters<typeof findResidentialBestMatch>[1],
          ) => findResidentialBestMatch(await loadMachiaza(lg, id), f),
        };
  const n = NewMatcher(repo, cities);

  const all = (cases as { file: string; cases: Expect[] }[])
    .filter((t) => t.file.startsWith("matching/issues/"))
    .flatMap((t) => t.cases.map((c) => ({ ...c, file: t.file })))
    .filter(
      (c) => typeof c.query === "object" && c.query !== null && typeof c.query.Address === "string",
    );

  const results = [];
  for (const c of all) {
    const scope = scopeOf(c.wantMatchLevel);
    const got = await Match(n, {
      address: c.query.Address,
      category: category(c.query.Category),
      pref: c.query.Pref ?? "",
      limit: c.query.Limit ?? 1,
    }).catch((e: unknown) => e as Error);
    const problems = got instanceof Error ? [`error: ${got.message}`] : diff(c, got[0]);
    const changed = intended.has(c.name) && problems.length > 0;
    results.push({
      file: c.file,
      name: c.name,
      address: c.query.Address,
      scope: changed ? "intended" : scope,
      ok: changed || problems.length === 0,
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
  console.log(
    `町字まで: ${count("town")}  住居表示: ${count("residential")}  地番: ${count("parcel")}  意図して変えた: ${count("intended")}`,
  );
  expect(results.length).toBeGreaterThan(0);
});
