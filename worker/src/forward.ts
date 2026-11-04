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
import { Detail, type MatchedResult } from "./model/model";
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
import { withRenamedWard } from "./renamed_ward";
import { TOWN_NAME_COLUMNS, type TownNameRow, withLeadingNoise, withoutCity } from "./no_city";
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
 * 列 column が value の行を読む口。表は初めて引くときに開く。
 * ファイルが分かれていれば全部のフッターを開き、行グループの範囲で当たるものだけ読む。
 * 覚えるのは最近の 1,024 個の値だけにする。keys が空なら何も読まない
 */
const keyLoader = <T>(bucket: R2Bucket, keys: string[], column: string, columns: string[]) => {
  let tables: Promise<Table[]> | null = null;
  const rows = new Map<string, Promise<T[]>>();
  return (value: string): Promise<T[]> => {
    if (keys.length === 0) return Promise.resolve([]);
    const hit = rows.get(value);
    if (hit) return hit;
    tables ??= openAll(bucket, keys);
    const p = tables
      .then((ts) =>
        Promise.all(
          ts.map((t) => readWhere<T>(t, column, value, columns, (n) => (stats.rows += n))),
        ),
      )
      .then((parts) => parts.flat());
    if (rows.size >= 1024) rows.delete(rows.keys().next().value as string);
    rows.set(value, p);
    p.catch(() => {
      rows.delete(value);
      tables = null;
    });
    return p;
  };
};

/** 町字 1 つ分の行を読む口 (住居表示・地番・代表点の表)。表は番号まである住所で初めて開く */
const machiazaLoader = <T>(bucket: R2Bucket, keys: string[], columns: string[]) => {
  const load = keyLoader<T>(bucket, keys, "machiaza_key", columns);
  return (lgCode: string, machiazaId: string): Promise<T[]> =>
    load(machiazaKey(lgCode, machiazaId));
};

/** 当て方と、町字 1 つの行を引く口 (郵便番号を足すのに使う) */
type Built = {
  matcher: Impl;
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>;
  towns: (lgCode: string) => Promise<BasicResult[]>;
  rows: (lgCode: string, machiazaId: string) => Promise<RsdtdspRow[]>;
  points: (lgCode: string, machiazaId: string) => Promise<PointRow[]>;
  city: (lgCode: string) => CityResult | undefined;
  names: (key: string) => Promise<TownNameRow[]>;
  cities: readonly CityResult[];
};

// isolate の中で使い回す。表のファイルが変われば作り直す
let cached: { key: string; matcher: Promise<Built> } | null = null;

const build = async (bucket: R2Bucket, { tables }: Resolved): Promise<Built> => {
  const [town, city, pref] = await Promise.all(
    [tables.town, tables.city, tables.pref].map((keys) => openAll(bucket, keys)),
  );
  const cities = (await Promise.all(city.map((t) => readAll<CityTableRow>(t)))).flat().map(toCity);
  const prefs = (await Promise.all(pref.map((t) => readAll<PrefTableRow>(t)))).flat().map(toPref);
  const cityByCode = new Map(cities.map((c) => [c.lgCode, c]));
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
    city: (lgCode) => cityByCode.get(lgCode),
    cities,
    names: keyLoader<TownNameRow>(bucket, tables.town_name, "name_key", TOWN_NAME_COLUMNS),
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

/** limit の上限 (src/index.ts の limit と同じ) */
const MAX_LIMIT = 10;

/**
 * 結果を絞る地域に入るか。area は都道府県コード (2 桁) か市区町村コード (5 桁)。
 * 政令市のコードは区のコードの頭にならない (横浜市 14100、中区 14104) ので、政令市なら区も含める
 */
export const areaFilter = (
  cities: readonly CityResult[],
  area: string | undefined,
): ((code: string | null) => boolean) => {
  if (area === undefined) return () => true;
  if (area.length === 2) return (code) => (code ?? "").startsWith(area);
  const parents = cities.filter((c) => c.lgCode.startsWith(area) && !c.ward);
  const codes = new Set(
    cities
      .filter(
        (c) =>
          c.lgCode.startsWith(area) ||
          parents.some(
            (p) => p.pref === c.pref && (p.county ?? "") === (c.county ?? "") && p.city === c.city,
          ),
      )
      .map((c) => c.lgCode.slice(0, 5)),
  );
  return (code) => codes.has((code ?? "").slice(0, 5));
};

export const geocode = async (
  env: ForwardEnv,
  address: string,
  limit: number,
  /** 都道府県コード (2 桁) か市区町村コード (5 桁)。渡されたら、その中の結果だけを返す */
  area?: string,
): Promise<{
  results: MatchedResult[];
  postalCode: (r: MatchedResult) => Promise<string | null>;
}> => {
  stats = emptyStats();
  const cold = cached === null;
  const built = await matcherFor(env);
  const match = (a: string, n = limit) =>
    Match(built.matcher, { address: preNormalize(a), category: "all", pref: "", limit: n });
  const inArea = areaFilter(built.cities, area);
  const cities = built.cities.filter((c) => inArea(c.lgCode));
  // 地域で絞るときは、地域の外の候補で limit が埋まらないよう、上流からは上限まで受け取る
  const upstream = await match(address, area === undefined ? limit : MAX_LIMIT);
  const noCity = await Promise.all(
    upstream.map(async (r) => {
      const n = await withLeadingNoise(r, address, match);
      // 市区町村まで決まった地域の外の結果は、この後の段で地域の中に移らない
      if (Detail(n.match_level) >= Detail("city") && !inArea(n.ids.lg_code)) return [];
      // 補った候補は、頭の limit 件より後ろが結果に残らない。後ろの段で読む量を増やさない
      return (await withoutCity(n, address, built.names, cities, match)).slice(0, limit);
    }),
  );
  const results = await Promise.all(
    noCity.flat().map(async (r) => {
      const out = await withAzaSkipped(
        await withOazaChome(await withRenamedWard(r, address, match), address, match),
        match,
      );
      // 当て直した結果に、市区町村を推定した候補の数を引き継ぐ
      return r.candidates === undefined || out === r ? out : { ...out, candidates: r.candidates };
    }),
  );
  // ログには住所を書かない。読んだ量と時間だけ (住所と結果は src/request_log.ts で別に記録する)
  console.log(JSON.stringify({ geocode: true, cold, ...stats }));
  // 当たらなかったもの (都道府県も決まらない) は返さない
  const found = await Promise.all(
    results
      .filter((r) => r.match_level !== "unknown" && inArea(r.ids.lg_code))
      .slice(0, limit)
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
