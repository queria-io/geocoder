// 住所 → 町字の正引き。R2 に置いた geocoder の表 (town・city・pref の Parquet) を読み、
// abr-geocoder から写した当て方 (matching/) に渡す。市区町村と都道府県の表は小さいので丸ごと、
// 町字の表は市区町村 1 つ分の行グループだけを読む
import { parquetReadObjects } from "hyparquet";

import {
  compressors,
  openTable,
  r2Buffer,
  readCity,
  readWhere,
  retryOnce,
  type Table,
} from "./data/parquet";
import { Match } from "./matching/match_core";
import { NewMatcher, type Impl } from "./matching/matcher";
import type { MatchedResult } from "./model/model";
import { lazyRepository } from "./repository/lazy";
import {
  TOWN_COLUMNS,
  toBasic,
  toCity,
  toPref,
  type CityTableRow,
  type PrefTableRow,
  type TownRow,
} from "./repository/town";
import { PARCEL_COLUMNS, type ParcelRow } from "./repository/parcel";
import { machiazaKey, RSDTDSP_COLUMNS, type RsdtdspRow } from "./repository/rsdtdsp";
import type { BasicResult } from "./repository/types";

export type ForwardEnv = {
  DATA: R2Bucket;
  /** R2 の中の表のファイル。FDL の refs/heads/main が指すバージョンから読むまでの仮置き */
  TOWN_PARQUET: string;
  CITY_PARQUET: string;
  PREF_PARQUET: string;
  RSDTDSP_PARQUET: string;
  /** 空なら地番の段は流さない */
  PARCEL_PARQUET: string;
};

/** 1 件の問い合わせで何をどれだけ読んだか。重いところを探すためにログへ出す */
export type ForwardStats = { reads: number; bytes: number; cities: string[]; rows: number };
let stats: ForwardStats = { reads: 0, bytes: 0, cities: [], rows: 0 };
const countRead = (bytes: number) => {
  stats.reads += 1;
  stats.bytes += bytes;
};

const open = async (bucket: R2Bucket, key: string): Promise<Table> => {
  const head = await retryOnce(() => bucket.head(key));
  if (!head) throw new Error(`not found: ${key}`);
  return openTable(r2Buffer(bucket, key, head.size, countRead));
};

const readAll = async <T>(t: Table): Promise<T[]> =>
  (await parquetReadObjects({ file: t.file, metadata: t.metadata, compressors })) as T[];

/**
 * 町字 1 つ分の行を読む口 (住居表示・地番の表)。表は番号まである住所で初めて開く。
 * 覚えるのは最近の町字だけにする (町字は全国で数十万ある)。key が空なら何も読まない
 */
const machiazaLoader = <T>(bucket: R2Bucket, key: string, columns: string[]) => {
  let table: Promise<Table> | null = null;
  const rows = new Map<string, Promise<T[]>>();
  return (lgCode: string, machiazaId: string): Promise<T[]> => {
    if (key === "") return Promise.resolve([]);
    const k = machiazaKey(lgCode, machiazaId);
    const hit = rows.get(k);
    if (hit) return hit;
    table ??= open(bucket, key);
    const p = table.then((t) =>
      readWhere<T>(t, "machiaza_key", k, columns, (n) => (stats.rows += n)),
    );
    if (rows.size >= 1024) rows.delete(rows.keys().next().value as string);
    rows.set(k, p);
    p.catch(() => {
      rows.delete(k);
      table = null;
    });
    return p;
  };
};

/** 当て方と、町字 1 つの行を引く口 (郵便番号を足すのに使う) */
type Built = {
  matcher: Impl;
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>;
};

// isolate の中で使い回す。表のファイルが変われば作り直す
let cached: { key: string; matcher: Promise<Built> } | null = null;

const build = async (env: ForwardEnv): Promise<Built> => {
  const [town, city, pref] = await Promise.all(
    [env.TOWN_PARQUET, env.CITY_PARQUET, env.PREF_PARQUET].map((k) => open(env.DATA, k)),
  );
  const cities = (await readAll<CityTableRow>(city)).map(toCity);
  const prefs = (await readAll<PrefTableRow>(pref)).map(toPref);
  const towns = new Map<string, Promise<BasicResult[]>>();
  const loadCity = (lgCode: string) => {
    const hit = towns.get(lgCode);
    if (hit) return hit;
    stats.cities.push(lgCode);
    const p = readCity<TownRow>(town, lgCode, TOWN_COLUMNS, (n) => (stats.rows += n)).then((rows) =>
      rows.map(toBasic),
    );
    towns.set(lgCode, p);
    // 読めなかった市区町村は覚えずに、次の問い合わせで読み直す
    p.catch(() => towns.delete(lgCode));
    return p;
  };
  const loadMachiaza = machiazaLoader<RsdtdspRow>(env.DATA, env.RSDTDSP_PARQUET, RSDTDSP_COLUMNS);
  const loadParcels = machiazaLoader<ParcelRow>(env.DATA, env.PARCEL_PARQUET, PARCEL_COLUMNS);
  return {
    matcher: NewMatcher(lazyRepository(loadCity, cities, prefs, loadMachiaza, loadParcels), cities),
    town: async (lgCode, machiazaId) =>
      (await loadCity(lgCode)).find((b) => b.machiazaId === machiazaId) ?? null,
  };
};

const matcherFor = (env: ForwardEnv): Promise<Built> => {
  const key = [
    env.TOWN_PARQUET,
    env.CITY_PARQUET,
    env.PREF_PARQUET,
    env.RSDTDSP_PARQUET,
    env.PARCEL_PARQUET,
  ].join("\n");
  if (cached?.key !== key) {
    const matcher = build(env);
    matcher.catch(() => (cached = null));
    cached = { key, matcher };
  }
  return cached.matcher;
};

export const geocode = async (
  env: ForwardEnv,
  address: string,
  limit: number,
): Promise<{
  results: MatchedResult[];
  postalCode: (r: MatchedResult) => Promise<string | null>;
}> => {
  stats = { reads: 0, bytes: 0, cities: [], rows: 0 };
  const cold = cached === null;
  const built = await matcherFor(env);
  const results = await Match(built.matcher, { address, category: "all", pref: "", limit });
  console.log(JSON.stringify({ geocode: address, cold, ...stats }));
  // 当たらなかったもの (都道府県も決まらない) は返さない
  const found = results.filter((r) => r.match_level !== "unknown");
  const postalCode = async (r: MatchedResult) =>
    r.ids.lg_code && r.ids.machiaza_id
      ? ((await built.town(r.ids.lg_code, r.ids.machiaza_id))?.postCode ?? null)
      : null;
  return { results: found, postalCode };
};
