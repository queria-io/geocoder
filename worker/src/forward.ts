// 住所 → 町字の正引き。R2 に置いた geocoder の表 (town・city・pref の Parquet) を読み、
// abr-geocoder から写した当て方 (matching/) に渡す。市区町村と都道府県の表は小さいので丸ごと、
// 町字の表は市区町村 1 つ分の行グループだけを読む
import { preNormalize } from "./matching/pre_normalize";
import { parquetReadObjects } from "hyparquet";

import {
  compressors,
  openR2Table,
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
import { resolveTables, type Resolved } from "./data/source";
import { machiazaKey, RSDTDSP_COLUMNS, type RsdtdspRow } from "./repository/rsdtdsp";
import type { BasicResult, CityResult } from "./repository/types";
import { nearestAddress, type Nearby } from "./nearby";
import { withAzaSkipped } from "./skip_aza";
import { withOazaChome } from "./oaza_chome";
import { POINT_COLUMNS, type PointRow, withAddressPoint } from "./point";
import { withParentPoint } from "./parent_point";

export type ForwardEnv = {
  DATA: R2Bucket;
  /**
   * 表の置き場 (DATA の中のキー)。「…/」なら FDL のリポジトリで、refs/heads/main が指すバージョンを読む。
   * 「….json」なら表ごとのファイルを並べた目録 (src/data/source.ts)
   */
  DATA_SOURCE: string;
  /** FDL のバージョンを固定するときの ID。空なら refs/heads/main に従う */
  DATA_PIN?: string;
};

/** 1 件の問い合わせで何をどれだけ読んだか。重いところを探すためにログへ出す */
export type ForwardStats = {
  reads: number;
  bytes: number;
  /** R2 を待った時間の合計 (読みが並ぶと重なる) */
  r2_ms: number;
  cities: string[];
  rows: number;
};
const emptyStats = (): ForwardStats => ({ reads: 0, bytes: 0, r2_ms: 0, cities: [], rows: 0 });
let stats = emptyStats();
const countRead = (bytes: number, ms: number) => {
  stats.reads += 1;
  stats.bytes += bytes;
  stats.r2_ms += ms;
};

const open = (bucket: R2Bucket, key: string): Promise<Table> => openR2Table(bucket, key, countRead);

const readAll = async <T>(t: Table): Promise<T[]> =>
  (await parquetReadObjects({ file: t.file, metadata: t.metadata, compressors })) as T[];

const openAll = (bucket: R2Bucket, keys: string[]): Promise<Table[]> =>
  Promise.all(keys.map((k) => open(bucket, k)));

/**
 * 町字 1 つ分の行を読む口 (住居表示・地番の表)。表は番号まである住所で初めて開く。
 * ファイルが分かれていれば全部のフッターを開き、行グループの範囲で当たるものだけ読む。
 * 覚えるのは最近の町字だけにする (町字は全国で数十万ある)。key が空なら何も読まない
 */
const machiazaLoader = <T>(bucket: R2Bucket, keys: string[], columns: string[]) => {
  let tables: Promise<Table[]> | null = null;
  const rows = new Map<string, Promise<T[]>>();
  return (lgCode: string, machiazaId: string): Promise<T[]> => {
    if (keys.length === 0) return Promise.resolve([]);
    const k = machiazaKey(lgCode, machiazaId);
    const hit = rows.get(k);
    if (hit) return hit;
    tables ??= openAll(bucket, keys);
    const p = tables
      .then((ts) =>
        Promise.all(
          ts.map((t) => readWhere<T>(t, "machiaza_key", k, columns, (n) => (stats.rows += n))),
        ),
      )
      .then((parts) => parts.flat());
    if (rows.size >= 1024) rows.delete(rows.keys().next().value as string);
    rows.set(k, p);
    p.catch(() => {
      rows.delete(k);
      tables = null;
    });
    return p;
  };
};

/** 当て方と、町字 1 つの行を引く口 (郵便番号を足すのに使う) */
type Built = {
  matcher: Impl;
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>;
  towns: (lgCode: string) => Promise<BasicResult[]>;
  rows: (lgCode: string, machiazaId: string) => Promise<RsdtdspRow[]>;
  points: (lgCode: string, machiazaId: string) => Promise<PointRow[]>;
  city: (lgCode: string) => CityResult | undefined;
};

// isolate の中で使い回す。表のファイルが変われば作り直す
let cached: { key: string; matcher: Promise<Built> } | null = null;

const build = async (bucket: R2Bucket, { tables }: Resolved): Promise<Built> => {
  const [town, city, pref] = await Promise.all(
    [tables.town, tables.city, tables.pref].map((keys) => openAll(bucket, keys)),
  );
  const cities = (await Promise.all(city.map((t) => readAll<CityTableRow>(t)))).flat().map(toCity);
  const prefs = (await Promise.all(pref.map((t) => readAll<PrefTableRow>(t)))).flat().map(toPref);
  const towns = new Map<string, Promise<BasicResult[]>>();
  const loadCity = (lgCode: string) => {
    const hit = towns.get(lgCode);
    if (hit) return hit;
    stats.cities.push(lgCode);
    const p = Promise.all(
      town.map((t) => readCity<TownRow>(t, lgCode, TOWN_COLUMNS, (n) => (stats.rows += n))),
    ).then((parts) => parts.flat().map(toBasic));
    towns.set(lgCode, p);
    // 読めなかった市区町村は覚えずに、次の問い合わせで読み直す
    p.catch(() => towns.delete(lgCode));
    return p;
  };
  const loadMachiaza = machiazaLoader<RsdtdspRow>(bucket, tables.rsdtdsp, RSDTDSP_COLUMNS);
  const loadParcels = machiazaLoader<ParcelRow>(bucket, tables.parcel, PARCEL_COLUMNS);
  return {
    matcher: NewMatcher(lazyRepository(loadCity, cities, prefs, loadMachiaza, loadParcels), cities),
    town: async (lgCode, machiazaId) =>
      (await loadCity(lgCode)).find((b) => b.machiazaId === machiazaId) ?? null,
    towns: loadCity,
    rows: loadMachiaza,
    points: machiazaLoader<PointRow>(bucket, tables.point, POINT_COLUMNS),
    city: (lgCode) => cities.find((c) => c.lgCode === lgCode),
  };
};

/** 今読む表のバージョン。答えに付け、キャッシュの鍵にも使う */
export const dataVersion = async (env: ForwardEnv): Promise<string> =>
  (await resolveTables(env.DATA, env.DATA_SOURCE, env.DATA_PIN)).version;

const matcherFor = async (env: ForwardEnv): Promise<Built> => {
  const resolved = await resolveTables(env.DATA, env.DATA_SOURCE, env.DATA_PIN);
  const key = JSON.stringify(resolved.tables);
  if (cached?.key !== key) {
    const matcher = build(env.DATA, resolved);
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
  stats = emptyStats();
  const cold = cached === null;
  const built = await matcherFor(env);
  const match = (a: string) =>
    Match(built.matcher, { address: preNormalize(a), category: "all", pref: "", limit });
  const results = await Promise.all(
    (await match(address)).map(async (r) =>
      withAzaSkipped(await withOazaChome(r, address, match), match),
    ),
  );
  // 住所は残さない。読んだ量と時間だけを書く
  console.log(JSON.stringify({ geocode: true, cold, ...stats }));
  // 当たらなかったもの (都道府県も決まらない) は返さない
  const found = await Promise.all(
    results
      .filter((r) => r.match_level !== "unknown")
      .map(async (r) =>
        withParentPoint(
          await withAddressPoint(r, built.points, built.town),
          built.town,
          built.city,
        ),
      ),
  );
  const postalCode = async (r: MatchedResult) =>
    r.ids.lg_code && r.ids.machiaza_id
      ? ((await built.town(r.ids.lg_code, r.ids.machiaza_id))?.postCode ?? null)
      : null;
  return { results: found, postalCode };
};

/** 座標の近くの住所。lgCode は境界タイルで決めた市区町村 (6 桁) */
export const nearby = async (
  env: ForwardEnv,
  lgCode: string,
  lat: number,
  lng: number,
): Promise<Nearby | null> => {
  const built = await matcherFor(env);
  return nearestAddress(await built.towns(lgCode), built.rows, lat, lng);
};
