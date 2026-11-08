// 住所 → 町字の正引き。geocoder の表の Parquet を読み、abr-geocoder から写した当て方 (matching/) に渡す。
// 表は Worker の静的アセットにあればそこから丸ごと、無ければ R2 から Range で読む。
// 町字と照合の区域は都道府県ごと、住居表示・地番・番号は市区町村ごと、町名の索引は頭の文字ごとのファイルに
// 分かれていて、要るファイルだけを開く。開いたファイル (フッター) は isolate の中で使い回し、読んだ行と
// 静的アセットから取ったファイルの中身は問い合わせが終われば手放す
import { preNormalize } from "./matching/pre_normalize";
import { parquetReadObjects } from "hyparquet";

import {
  assetsBuffer,
  compressors,
  type Keep,
  openR2Table,
  openSized,
  readWhere,
  type Table,
  valueOf,
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
import {
  filesFor,
  nameBucket,
  type Partition,
  resolveAssets,
  resolveTables,
  type Resolved,
  type TableName,
} from "./data/source";
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
import { stepIf } from "./evidence";

export type ForwardEnv = {
  /**
   * Worker の静的アセット。pnpm build:data で表を置いていて、そのバージョンが R2 で今読むバージョンと
   * 同じなら、R2 ではなくここから読む
   */
  ASSETS?: Fetcher;
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
  /** 読み込みを待った時間の合計 (読みが並ぶと重なる) */
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
const startRequest = () => {
  stats = emptyStats();
};

/** 静的アセットから取ったファイルの中身。1 件の問い合わせ (Session) ごとに持ち、終われば手放す */
type Files = Map<string, Promise<ArrayBuffer>>;

/** 行を絞って読む表 (市区町村と都道府県の表は丸ごと読む) */
type KeyedTable = Exclude<TableName, "city" | "pref">;

/** 表ごとの、行グループを絞る列と読む列 */
const KEEP: Record<KeyedTable, Keep & { sortKey: string; columns: string[] }> = {
  town: { sortKey: "lg_code", columns: TOWN_COLUMNS },
  match_area: { sortKey: "lg_code", columns: MATCH_AREA_COLUMNS },
  match_number: { sortKey: "area_id", columns: MATCH_NUMBER_COLUMNS },
  rsdtdsp: { sortKey: "machiaza_key", columns: RSDTDSP_COLUMNS },
  parcel: { sortKey: "machiaza_key", columns: PARCEL_COLUMNS },
  town_name: { sortKey: "name_key", columns: TOWN_NAME_COLUMNS },
  former_city: { sortKey: "name_key", columns: FORMER_CITY_COLUMNS },
};

/** 町字が決まった後に読む表 (市区町村ごとのファイル) */
const AFTER_TOWN: readonly KeyedTable[] = ["match_area", "match_number", "rsdtdsp", "parcel"];

/** 市区町村 lgCode の行が入るファイル。市区町村ごとの表と、都道府県ごとの表のどちらでも選べる */
const cityPart = (lgCode: string): Partition => ({
  pref_code: lgCode.slice(0, 2),
  lg_code: lgCode,
});

/** 丸ごと読む表 (市区町村・都道府県) は全部の列を残す */
const keepOf = (name: TableName): Keep | undefined =>
  name === "city" || name === "pref" ? undefined : KEEP[name];

const readAll = async <T>(t: Table): Promise<T[]> =>
  (await parquetReadObjects({ file: t.file, metadata: t.metadata, compressors })) as T[];

const prefOf = (lgCode: string) => lgCode.slice(0, 2);

/**
 * 表のファイルを開く口。静的アセットか R2 か。open で開いた表 (フッター) は isolate の中で使い回し、
 * 読むときは bind で問い合わせの files に結び直す (静的アセットの中身を問い合わせごとに持つため)
 */
type Opener = {
  open: (key: string, keep: Keep | undefined, files: Files) => Promise<Table>;
  bind: (key: string, table: Table, files: Files) => Table;
};

const r2Opener = (bucket: R2Bucket, sizes: Resolved["sizes"]): Opener => ({
  open: (key, keep) => openR2Table(bucket, key, countRead, keep, sizes[key]),
  bind: (_key, table) => table,
});

const assetsOpener = (assets: Fetcher, sizes: Resolved["sizes"]): Opener => {
  const buffer = (key: string, bytes: number, files: Files) =>
    assetsBuffer(assets, key, bytes, () => files, countRead);
  return {
    open: (key, keep, files) => {
      const size = sizes[key];
      if (!size) return Promise.reject(new Error(`no size: ${key}`));
      return openSized(buffer(key, size.bytes, files), size, keep);
    },
    bind: (key, table, files) => ({ ...table, file: buffer(key, table.file.byteLength, files) }),
  };
};
/** isolate の中で使い回すもの。表のファイルが変われば作り直す */
type Built = {
  /** 当て方の辞書 (市区町村の表から作る)。町字を読む口は問い合わせごとに差し替える */
  base: Impl;
  cities: CityRow[];
  prefs: PrefRow[];
  city: (lgCode: string) => CityResult | undefined;
  /** 表 name の、want の行が入るファイルを開き、問い合わせの files に結ぶ (一度開いたファイルは使い回す) */
  open: (name: TableName, want: Partition, files: Files) => Promise<Table[]>;
  /** 町字を読むときに、町字から先で読む表のファイルも開いておくか。R2 では開くのはフッターだけなので読みを
   * 並べられる。静的アセットでは開くとファイルを丸ごと取るので、要るときまで開かない */
  prefetch: boolean;
  /** 照合の索引 (match_area・match_number) があるか。無い目録では町字から先を引き直さない */
  hasIndex: boolean;
};

let cached: { key: string; built: Promise<Built> } | null = null;

const build = async (openKey: Opener, { tables }: Resolved, prefetch: boolean): Promise<Built> => {
  // 分けていない表のファイルはどの住所からも開くので、ファイルごとに 1 回だけ開く
  const opened = new Map<string, Promise<Table>>();
  const openFile = (name: TableName, key: string, files: Files) => {
    const hit = opened.get(key);
    if (hit) return hit;
    const p = openKey.open(key, keepOf(name), files);
    opened.set(key, p);
    // 開けなかったファイルは覚えずに、次の問い合わせで開き直す
    p.catch(() => opened.delete(key));
    return p;
  };
  const open = (name: TableName, want: Partition, files: Files) =>
    Promise.all(
      filesFor(tables[name], want).map(async (k) =>
        openKey.bind(k, await openFile(name, k, files), files),
      ),
    );
  const first: Files = new Map();
  const [city, pref] = await Promise.all([open("city", {}, first), open("pref", {}, first)]);
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
    prefetch,
    hasIndex: tables.match_area.length > 0 && tables.match_number.length > 0,
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
 * 表 name の、並べた列が values のどれかである行を読む口。want の行が入るファイルだけを読む。
 * 同じ値は問い合わせの中で 1 回だけ読み、まとめて渡された値は行グループを 1 回だけ読む
 */
const rowsOf = <T extends Record<string, unknown>, V extends string | number>(
  built: Built,
  name: KeyedTable,
  files: Files,
) => {
  const { sortKey, columns } = KEEP[name];
  const kept = new Map<V, Promise<T[]>>();
  return async (want: Partition, values: readonly V[]): Promise<T[]> => {
    const unique = [...new Set(values)];
    const missing = unique.filter((v) => !kept.has(v));
    if (missing.length > 0) {
      // 読んだ行は値ごとに 1 回で分ける (値ごとに全部の行を見直さない)
      const read = built
        .open(name, want, files)
        .then((ts) =>
          Promise.all(ts.map((t) => readWhere<T>(t, sortKey, missing, columns, countRows))),
        )
        .then((parts) => Map.groupBy(parts.flat(), (r) => valueOf(r[sortKey])));
      for (const v of missing)
        kept.set(
          v,
          read.then((byValue) => byValue.get(v) ?? []),
        );
    }
    return (await Promise.all(unique.map((v) => kept.get(v) ?? []))).flat();
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
  const files: Files = new Map();
  const townRows = rowsOf<TownRow, string>(built, "town", files);
  /** 市区町村ごとの町字。まだ読んでいない市区町村は、都道府県ごとに 1 回の読みでまとめて読む */
  const kept = new Map<string, Promise<BasicResult[]>>();
  const townsOf = async (lgCodes: readonly string[]): Promise<BasicResult[]> => {
    const missing = [...new Set(lgCodes)].filter((c) => !kept.has(c));
    stats.cities.push(...missing);
    // 町字から先で読む表のファイルも、この市区町村のものを今のうちに開いておく (読みを並べる)。
    // 開けなくても、使うときに開き直す
    if (built.prefetch)
      for (const c of missing)
        for (const name of AFTER_TOWN) built.open(name, cityPart(c), files).catch(() => []);
    for (const [prefCode, codes] of Map.groupBy(missing, prefOf)) {
      const read = townRows({ pref_code: prefCode }, codes);
      for (const c of codes)
        kept.set(
          c,
          read.then((rows) => rows.filter((r) => r.lg_code === c).map(toBasic)),
        );
    }
    return (await Promise.all(lgCodes.map((c) => kept.get(c) ?? []))).flat();
  };
  const towns = (lgCode: string) => townsOf([lgCode]);
  const town = async (lgCode: string, machiazaId: string) =>
    (await towns(lgCode)).find((b) => b.machiazaId === machiazaId) ?? null;
  const byMachiaza = <T extends Record<string, unknown>>(name: KeyedTable) => {
    const read = rowsOf<T, string>(built, name, files);
    return (lgCode: string, machiazaIds: readonly string[]) =>
      read(
        cityPart(lgCode),
        machiazaIds.map((m) => machiazaKey(lgCode, m)),
      );
  };
  const rsdt = byMachiaza<RsdtdspRow>("rsdtdsp");
  const parcels = byMachiaza<ParcelRow>("parcel");
  const numbers = rowsOf<MatchNumberRow, number>(built, "match_number", files);
  const areaRows = rowsOf<MatchAreaRow, string>(built, "match_area", files);
  const areas = once(async (lgCode: string) =>
    cityIndex(await areaRows(cityPart(lgCode), [lgCode])),
  );
  const byName = <T extends Record<string, unknown>>(name: KeyedTable) => {
    const read = rowsOf<T, string>(built, name, files);
    return (key: string) => read({ name_bucket: nameBucket(key) }, [key]);
  };
  const one =
    <T>(read: (lgCode: string, ids: readonly string[]) => Promise<T[]>) =>
    (lgCode: string, machiazaId: string) =>
      read(lgCode, [machiazaId]);
  return {
    matcher: {
      ...built.base,
      repo: lazyRepository(townsOf, built.cities, built.prefs, one(rsdt), one(parcels)),
    },
    town,
    towns,
    rows: one(rsdt),
    names: byName<TownNameRow>("town_name"),
    formers: byName<FormerCityRow>("former_city"),
    locate: {
      index: areas,
      numbers: (lgCode, ids) => numbers(cityPart(lgCode), ids),
      rsdt,
      parcels,
      town,
      city: built.city,
    },
  };
};

/** 今読む表のバージョン。答えに付け、キャッシュの鍵にも使う */
export const dataVersion = async (env: ForwardEnv): Promise<string> =>
  (await sourceOf(env)).resolved.version;

/** 表を読む先。静的アセットに置いてあればそこ、無ければ R2 */
type Source = { resolved: Resolved; open: Opener; inAssets: boolean };

const sourceOf = async (env: ForwardEnv): Promise<Source> => {
  const assets = env.ASSETS ? await resolveAssets(env.ASSETS).catch(() => null) : null;
  const tables = resolveTables(env.DATA, env.DATA_SOURCE, env.DATA_PIN);
  // R2 の読む先を読めないときは、静的アセットに置いたデータで答える
  const resolved = assets ? await tables.catch(() => assets) : await tables;
  // 静的アセットは、R2 で今読むバージョン (refs/heads/main か DATA_PIN) と同じときだけ使う。
  // Sync で main が進んだときや DATA_PIN で固定したときは、デプロイし直すまで R2 から読む
  if (env.ASSETS && assets?.version === resolved.version)
    return { resolved: assets, open: assetsOpener(env.ASSETS, assets.sizes), inAssets: true };
  return { resolved, open: r2Opener(env.DATA, resolved.sizes), inAssets: false };
};

const builtFor = async (env: ForwardEnv): Promise<Built> => {
  const { resolved, open, inAssets } = await sourceOf(env);
  const key = JSON.stringify(resolved.tables);
  if (cached?.key !== key) {
    const built = build(open, resolved, !inAssets);
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
  startRequest();
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
      const n = stepIf(
        r,
        await withFormerCity(r, address, s.formers, built.city, match),
        "former_city",
      );
      // 市区町村まで決まった地域の外の結果は、この後の段で地域の中に移らない
      if (Detail(n.match_level) >= Detail("city") && !inArea(n.ids.lg_code)) return [];
      // 旧市区町村名を読み替えたら、この後の段は読み替えた後の住所から読む
      const read = n.former_address ?? address;
      // 候補は座標を引いてから並べ直すので、limit ではなく上限まで残す
      const candidates = (await withoutCity(n, read, s.names, cities, match)).slice(0, MAX_LIMIT);
      const retried = await Promise.all(
        candidates.map(async (c) => {
          // 段ごとに、結果が変わったら使った段として steps に足す (include=evidence)
          const ward = stepIf(c, await withRenamedWard(c, read, match), "renamed_ward");
          const oaza = stepIf(ward, await withOazaChome(ward, read, match), "oaza_omitted");
          const skipped = stepIf(oaza, await withAzaSkipped(oaza, match), "aza_skipped");
          // 市区町村を推定した候補は、番号まで再照合すると並びが変わり別の市区町村が勝つので、再照合しない
          const out =
            (c.candidates ?? 1) > 1
              ? skipped
              : stepIf(skipped, await withNumberTail(skipped, read, match), "number_tail");
          // 当て直した結果に、市区町村を推定した候補の数と、読み替えた後の住所を引き継ぐ
          if (out === c) return out;
          return {
            ...out,
            ...(c.candidates === undefined ? {} : { candidates: c.candidates }),
            ...(c.former_address === undefined ? {} : { former_address: c.former_address }),
          };
        }),
      );
      // 当たらなかったもの (都道府県も決まらない) は返さない
      return retried.filter((x) => x.match_level !== "unknown" && inArea(x.ids.lg_code));
    }),
  );
  // ログには住所を書かない。読んだ量と時間だけ (住所と結果は src/request_log.ts で別に記録する)
  console.log(JSON.stringify({ geocode: true, cold, ...stats }));
  // 照合の索引の無い目録では、引き直すと町字の答えがすべて市区町村に落ちるので、上流の答えのまま返す
  const withPoint = built.hasIndex
    ? (r: MatchedResult) => withLocated(r, r.former_address ?? address, s.locate)
    : async (r: MatchedResult) => [r];
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
  startRequest();
  const s = session(await builtFor(env));
  return nearestAddress(await s.towns(lgCode), s.rows, lat, lng);
};
