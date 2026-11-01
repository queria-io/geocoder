// 住所 → 町字の正引き。R2 に置いた geocoder の表 (town・city・pref の Parquet) を読み、
// abr-geocoder から写した当て方 (matching/) に渡す。市区町村と都道府県の表は小さいので丸ごと、
// 町字の表は市区町村 1 つ分の行グループだけを読む
import { parquetReadObjects } from "hyparquet";

import { compressors, openTable, r2Buffer, readCity, retryOnce, type Table } from "./data/parquet";
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
import type { BasicResult } from "./repository/types";

export type ForwardEnv = {
  DATA: R2Bucket;
  /** R2 の中の表のファイル。FDL の refs/heads/main が指すバージョンから読むまでの仮置き */
  TOWN_PARQUET: string;
  CITY_PARQUET: string;
  PREF_PARQUET: string;
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

// isolate の中で使い回す。表のファイルが変われば作り直す
let cached: { key: string; matcher: Promise<Impl> } | null = null;

const build = async (env: ForwardEnv): Promise<Impl> => {
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
  return NewMatcher(lazyRepository(loadCity, cities, prefs), cities);
};

const matcherFor = (env: ForwardEnv): Promise<Impl> => {
  const key = [env.TOWN_PARQUET, env.CITY_PARQUET, env.PREF_PARQUET].join("\n");
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
): Promise<MatchedResult[]> => {
  stats = { reads: 0, bytes: 0, cities: [], rows: 0 };
  const cold = cached === null;
  const results = await Match(await matcherFor(env), { address, category: "all", pref: "", limit });
  console.log(JSON.stringify({ geocode: address, cold, ...stats }));
  return results;
};
