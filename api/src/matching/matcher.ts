// abrg/internal/matching/matcher.go と、上流の cache/cache.go の Lookups の作り方の写し (upstream/UPSTREAM のコミット)
import type { CityRow } from "../repository/memory";
import type { Repository } from "../repository/types";
import { TextForDB } from "../transform/text";
import { NewCityBoundary, type CityBoundary } from "../util/city_boundary";
import { buildCityPrefixMap, type CityPrefixMap } from "./city_prefix";

export type WardCandidate = { CityWard: string; PrefCode: string };

export type Impl = {
  repo: Repository;
  cityPrefixMap: CityPrefixMap;
  cityWardLgCodes: Map<string, string>;
  wardCandidates: Map<string, WardCandidate[]>;
  cityBoundary: CityBoundary;
};

// 同じ名前を何度も正規化しないように覚えておく (市区町村の名前は数千で、isolate が冷たいときの固定費になる)
const normalized = new Map<string, string>();
const norm = (s: string): string => {
  const hit = normalized.get(s);
  if (hit !== undefined) return hit;
  const n = TextForDB(s)[0];
  normalized.set(s, n);
  return n;
};
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unique = <T>(xs: T[]): T[] => [...new Set(xs)];

/** 正規化すると同じになる名前 (鹿嶋市と鹿島市) が別の値を指すときは、どちらも外す */
const normalizeKeys = (raw: [string, string][]): Map<string, string> => {
  const groups = Map.groupBy(raw, ([k]) => norm(k));
  return new Map(
    [...groups]
      .filter(([, kvs]) => unique(kvs.map(([, v]) => v)).length === 1)
      .map(([k, kvs]) => [k, kvs[0][1]]),
  );
};

const cityWard = (c: CityRow): string => c.city + (c.ward ?? "");
const countyCityWard = (c: CityRow): string => (c.county ?? "") + c.city + (c.ward ?? "");

/** 市区町村の表から、当て方が使う辞書を作る */
export const NewMatcher = (repo: Repository, cities: CityRow[]): Impl => {
  const boundary = unique(
    cities.flatMap((c) => [cityWard(c), countyCityWard(c)]).filter((s) => s !== ""),
  );

  // 都道府県が 1 つに決まる市区町村名だけ
  const prefsByCity = Map.groupBy(cities, (c) => c.city);
  const cityPrefCodes = [...prefsByCity]
    .filter(([, rows]) => unique(rows.map((r) => r.prefCode)).length === 1)
    .map(([city, rows]): [string, string] => [city, rows[0].prefCode]);

  // lg_code が 1 つに決まる 市区町村+区 だけ。郡のある町村は 郡+町村 でも引けるようにする
  const byCityWard = Map.groupBy(cities, cityWard);
  const cityWardLgCodes = [...byCityWard]
    .filter(([, rows]) => unique(rows.map((r) => `${countyCityWard(r)}\t${r.lgCode}`)).length === 1)
    .flatMap(([cw, [r]]): [string, string][] =>
      countyCityWard(r) !== cw
        ? [
            [cw, r.lgCode],
            [countyCityWard(r), r.lgCode],
          ]
        : [[cw, r.lgCode]],
    );

  // 区の名前から、その区を持つ市の候補へ。都道府県コード、市+区 の順
  const wards = cities
    .filter((c) => c.ward !== null && c.ward !== "")
    .map((c) => ({ ward: c.ward as string, CityWard: cityWard(c), PrefCode: c.prefCode }));
  const distinctWards = [
    ...new Map(wards.map((w) => [`${w.ward}\t${w.CityWard}\t${w.PrefCode}`, w])).values(),
  ].sort(
    (a, b) =>
      order(a.ward, b.ward) || order(a.PrefCode, b.PrefCode) || order(a.CityWard, b.CityWard),
  );
  const wardCandidates = new Map<string, WardCandidate[]>();
  for (const w of distinctWards) {
    const key = norm(w.ward);
    wardCandidates.set(key, [
      ...(wardCandidates.get(key) ?? []),
      { CityWard: w.CityWard, PrefCode: w.PrefCode },
    ]);
  }

  return {
    repo,
    cityPrefixMap: buildCityPrefixMap(normalizeKeys(cityPrefCodes)),
    cityWardLgCodes: normalizeKeys(cityWardLgCodes),
    wardCandidates,
    cityBoundary: NewCityBoundary(boundary.map(norm)),
  };
};
