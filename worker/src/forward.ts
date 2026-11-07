// 住所 → 町字の正引き。R2 に置いた geocoder の表の Parquet を読み、abr-geocoder から写した当て方 (matching/) に渡す。
// 住居表示・地番・町字と照合の索引は都道府県ごとのファイルに分かれていて、住所の都道府県のファイルだけを開く。
// 開いたファイル (フッター) は isolate の中で使い回し、読んだ行は問い合わせが終われば手放す
import { preNormalize } from "./matching/pre_normalize";
import { parquetReadObjects } from "hyparquet";

import {
  compressors,
  type Keep,
  openR2Table,
  readCity,
  readWhere,
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
import { filesFor, resolveTables, type Resolved, type TableName } from "./data/source";
import { machiazaKey, RSDTDSP_COLUMNS, type RsdtdspRow } from "./repository/rsdtdsp";
import type { BasicResult, CityResult } from "./repository/types";
import type { CityRow, PrefRow } from "./repository/memory";
import { nearestAddress, type Nearby } from "./nearby";
import { withNumberTail } from "./number_tail";
import { withAzaSkipped } from "./skip_aza";
import { withOazaChome } from "./oaza_chome";
import { withRenamedWard } from "./renamed_ward";
import { FORMER_CITY_COLUMNS, type FormerCityRow, withFormerCity } from "./former_city";
import {
  MAX_LIMIT,
  orderCandidates,
  TOWN_NAME_COLUMNS,
  type TownNameRow,
  withoutCity,
} from "./no_city";
import {
  cityIndex,
  MATCH_AREA_COLUMNS,
  MATCH_NUMBER_COLUMNS,
  type MatchAreaRow,
  type MatchNumberRow,
} from "./locate/index";
import { type LocateDeps, withLocated } from "./locate/result";

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
const countRows = (n: number) => (stats.rows += n);

/** 表ごとの、行グループを絞る列と読む列 */
const KEEP: Partial<Record<TableName, Keep & { sortKey: string; columns: string[] }>> = {
  town: { sortKey: "lg_code", columns: TOWN_COLUMNS },
  match_area: { sortKey: "lg_code", columns: MATCH_AREA_COLUMNS },
  match_number: { sortKey: "area_id", columns: MATCH_NUMBER_COLUMNS },
  rsdtdsp: { sortKey: "machiaza_key", columns: RSDTDSP_COLUMNS },
  parcel: { sortKey: "machiaza_key", columns: PARCEL_COLUMNS },
  town_name: { sortKey: "name_key", columns: TOWN_NAME_COLUMNS },
  former_city: { sortKey: "name_key", columns: FORMER_CITY_COLUMNS },
};

const readAll = async <T>(t: Table): Promise<T[]> =>
  (await parquetReadObjects({ file: t.file, metadata: t.metadata, compressors })) as T[];

const prefOf = (lgCode: string) => lgCode.slice(0, 2);

/** isolate の中で使い回すもの。表のファイルが変われば作り直す */
type Built = {
  /** 当て方の辞書 (市区町村の表から作る)。町字を読む口は問い合わせごとに差し替える */
  base: Impl;
  cities: CityRow[];
  prefs: PrefRow[];
  city: (lgCode: string) => CityResult | undefined;
  /** 表 name の、都道府県 prefCode の行が入るファイルを開く (一度開いたファイルは使い回す) */
  open: (name: TableName, prefCode: string) => Promise<Table[]>;
};

let cached: { key: string; built: Promise<Built> } | null = null;

const build = async (bucket: R2Bucket, { tables }: Resolved): Promise<Built> => {
  // 分けていない表のファイルはどの都道府県からも開くので、ファイルごとに 1 回だけ開く
  const opened = new Map<string, Promise<Table>>();
  const openFile = (name: TableName, key: string) => {
    const hit = opened.get(key);
    if (hit) return hit;
    const p = openR2Table(bucket, key, countRead, KEEP[name]);
    opened.set(key, p);
    // 開けなかったファイルは覚えずに、次の問い合わせで開き直す
    p.catch(() => opened.delete(key));
    return p;
  };
  const open = (name: TableName, prefCode: string) =>
    Promise.all(filesFor(tables[name], prefCode).map((k) => openFile(name, k)));
  const [city, pref] = await Promise.all([open("city", ""), open("pref", "")]);
  const cities = (await Promise.all(city.map((t) => readAll<CityTableRow>(t)))).flat().map(toCity);
  const prefs = (await Promise.all(pref.map((t) => readAll<PrefTableRow>(t)))).flat().map(toPref);
  const cityByCode = new Map(cities.map((c) => [c.lgCode, c]));
  return {
    base: NewMatcher(
      lazyRepository(async () => [], cities, prefs),
      cities,
    ),
    cities,
    prefs,
    city: (lgCode) => cityByCode.get(lgCode),
    open,
  };
};

/** 一度だけ読む口。同じ鍵で何度呼んでも、問い合わせの中では 1 回だけ読む */
const once = <K, V>(load: (k: K) => Promise<V>): ((k: K) => Promise<V>) => {
  const kept = new Map<K, Promise<V>>();
  return (k) => {
    const hit = kept.get(k);
    if (hit) return hit;
    const p = load(k);
    kept.set(k, p);
    return p;
  };
};

/**
 * 表 name の、並べた列が values のどれかである行を読む口。都道府県 prefCode のファイルだけを読む。
 * 同じ値は問い合わせの中で 1 回だけ読み、まとめて渡された値は行グループを 1 回だけ読む
 */
const rowsOf = <T extends Record<string, unknown>, V extends string | number>(
  built: Built,
  name: TableName,
) => {
  const { sortKey, columns } = KEEP[name] ?? { sortKey: "", columns: [] };
  const kept = new Map<V, Promise<T[]>>();
  return async (prefCode: string, values: readonly V[]): Promise<T[]> => {
    const missing = [...new Set(values)].filter((v) => !kept.has(v));
    if (missing.length > 0) {
      const read = built
        .open(name, prefCode)
        .then((ts) =>
          Promise.all(ts.map((t) => readWhere<T>(t, sortKey, missing, columns, countRows))),
        )
        .then((parts) => parts.flat());
      for (const v of missing)
        kept.set(
          v,
          read.then((rows) => rows.filter((r) => r[sortKey] === v || Number(r[sortKey]) === v)),
        );
    }
    return (await Promise.all(values.map((v) => kept.get(v) ?? []))).flat();
  };
};

/** 1 件の問い合わせの間に使う、町字・番号を読む口と当て方 */
type Session = {
  matcher: Impl;
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>;
  towns: (lgCode: string) => Promise<BasicResult[]>;
  rows: (lgCode: string, machiazaId: string) => Promise<RsdtdspRow[]>;
  names: (key: string) => Promise<TownNameRow[]>;
  formers: (key: string) => Promise<FormerCityRow[]>;
  locate: LocateDeps;
};

const session = (built: Built): Session => {
  const towns = once(async (lgCode: string) => {
    stats.cities.push(lgCode);
    const ts = await built.open("town", prefOf(lgCode));
    const keep = KEEP.town?.columns ?? [];
    const parts = await Promise.all(ts.map((t) => readCity<TownRow>(t, lgCode, keep, countRows)));
    return parts.flat().map(toBasic);
  });
  const town = async (lgCode: string, machiazaId: string) =>
    (await towns(lgCode)).find((b) => b.machiazaId === machiazaId) ?? null;
  const byMachiaza = <T extends Record<string, unknown>>(name: TableName) => {
    const read = rowsOf<T, string>(built, name);
    return (lgCode: string, machiazaIds: readonly string[]) =>
      read(
        prefOf(lgCode),
        machiazaIds.map((m) => machiazaKey(lgCode, m)),
      );
  };
  const rsdt = byMachiaza<RsdtdspRow>("rsdtdsp");
  const parcels = byMachiaza<ParcelRow>("parcel");
  const numbers = rowsOf<MatchNumberRow, number>(built, "match_number");
  const areas = once(async (lgCode: string) => {
    const ts = await built.open("match_area", prefOf(lgCode));
    const keep = KEEP.match_area?.columns ?? [];
    const parts = await Promise.all(
      ts.map((t) => readCity<MatchAreaRow>(t, lgCode, keep, countRows)),
    );
    return cityIndex(parts.flat());
  });
  const byName = <T extends Record<string, unknown>>(name: TableName) => {
    const read = rowsOf<T, string>(built, name);
    return (key: string) => read("", [key]);
  };
  const one =
    <T>(read: (lgCode: string, ids: readonly string[]) => Promise<T[]>) =>
    (lgCode: string, machiazaId: string) =>
      read(lgCode, [machiazaId]);
  const loadCity = (lgCode: string) => towns(lgCode);
  return {
    matcher: {
      ...built.base,
      repo: lazyRepository(loadCity, built.cities, built.prefs, one(rsdt), one(parcels)),
    },
    town,
    towns,
    rows: one(rsdt),
    names: byName<TownNameRow>("town_name"),
    formers: byName<FormerCityRow>("former_city"),
    locate: {
      index: areas,
      numbers: (lgCode, ids) => numbers(prefOf(lgCode), ids),
      rsdt,
      parcels,
      town,
      city: built.city,
    },
  };
};

/** 今読む表のバージョン。答えに付け、キャッシュの鍵にも使う */
export const dataVersion = async (env: ForwardEnv): Promise<string> =>
  (await resolveTables(env.DATA, env.DATA_SOURCE, env.DATA_PIN)).version;

const builtFor = async (env: ForwardEnv): Promise<Built> => {
  const resolved = await resolveTables(env.DATA, env.DATA_SOURCE, env.DATA_PIN);
  const key = JSON.stringify(resolved.tables);
  if (cached?.key !== key) {
    const built = build(env.DATA, resolved);
    built.catch(() => (cached = null));
    cached = { key, built };
  }
  return cached.built;
};

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
  const built = await builtFor(env);
  const s = session(built);
  const match = (a: string, n = limit) =>
    Match(s.matcher, { address: preNormalize(a), category: "all", pref: "", limit: n });
  const inArea = areaFilter(built.cities, area);
  const cities = built.cities.filter((c) => inArea(c.lgCode));
  // 地域で絞るときは、地域の外の候補で limit が埋まらないよう、上流からは上限まで受け取る
  const upstream = await match(address, area === undefined ? limit : MAX_LIMIT);
  // 上流の結果ごとに、市区町村を補った候補の組を作る
  const groups = await Promise.all(
    upstream.map(async (r) => {
      const n = await withFormerCity(r, address, s.formers, built.city, match);
      // 市区町村まで決まった地域の外の結果は、この後の段で地域の中に移らない
      if (Detail(n.match_level) >= Detail("city") && !inArea(n.ids.lg_code)) return [];
      // 候補は座標を引いてから並べ直すので、limit ではなく上限まで残す
      const candidates = (await withoutCity(n, address, s.names, cities, match)).slice(
        0,
        MAX_LIMIT,
      );
      const retried = await Promise.all(
        candidates.map(async (c) => {
          const skipped = await withAzaSkipped(
            await withOazaChome(await withRenamedWard(c, address, match), address, match),
            match,
          );
          // 市区町村を推定した候補は、番号まで再照合すると並びが変わり別の市区町村が勝つので、再照合しない
          const out =
            (c.candidates ?? 1) > 1 ? skipped : await withNumberTail(skipped, address, match);
          // 当て直した結果に、市区町村を推定した候補の数と、旧市区町村名を読み替えた印を引き継ぐ
          if (out === c) return out;
          return {
            ...out,
            ...(c.candidates === undefined ? {} : { candidates: c.candidates }),
            ...(c.former_city === true ? { former_city: true } : {}),
          };
        }),
      );
      // 当たらなかったもの (都道府県も決まらない) は返さない
      return retried.filter((x) => x.match_level !== "unknown" && inArea(x.ids.lg_code));
    }),
  );
  // ログには住所を書かない。読んだ量と時間だけ (住所と結果は src/request_log.ts で別に記録する)
  console.log(JSON.stringify({ geocode: true, cold, ...stats }));
  const withPoint = (r: MatchedResult) => withLocated(r, address, s.locate);
  // 市区町村を推定した組は、座標を引いてから点の細かい順に並べる。ほかの結果は頭の limit 件だけ座標を引く
  const ordered: MatchedResult[] = [];
  for (const g of groups) {
    if (ordered.length >= limit) break;
    if (g.length > 1 && g.some((x) => (x.candidates ?? 1) > 1))
      ordered.push(...orderCandidates((await Promise.all(g.map(withPoint))).flat()));
    else
      ordered.push(
        ...(await Promise.all(g.slice(0, limit - ordered.length).map(withPoint))).flat(),
      );
  }
  const found = ordered.slice(0, limit);
  const postalCode = async (r: MatchedResult) =>
    r.ids.lg_code && r.ids.machiaza_id
      ? ((await s.town(r.ids.lg_code, r.ids.machiaza_id))?.postCode ?? null)
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
  const s = session(await builtFor(env));
  return nearestAddress(await s.towns(lgCode), s.rows, lat, lng);
};
