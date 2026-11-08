// 照合の索引を読む。区域 (match_area) は市区町村 1 つ分をまとめて、番号は区域ごとに
// 町字の表 (rsdtdsp・parcel) と match_number から読み、正規化した名前ごとにまとめる
import type { ParcelRow } from "../repository/parcel";
import type { RsdtdspRow } from "../repository/rsdtdsp";
import { type Area, type NumberPoint, type Numbers } from "./locate";
import { norm, numberKey } from "./norm";

export type MatchAreaRow = {
  area_id: number | bigint;
  lg_code: string;
  machiaza_id: string | null;
  name: string;
  numbering_name: string | null;
  own_point: boolean;
  lng: number | null;
  lat: number | null;
};

export const MATCH_AREA_COLUMNS = [
  "area_id",
  "lg_code",
  "machiaza_id",
  "name",
  "numbering_name",
  "own_point",
  "lng",
  "lat",
];

export type MatchNumberRow = {
  area_id: number | bigint;
  num: string;
  point_type: string;
  source: string;
  rank: number | bigint;
  machiaza_id: string | null;
  lng: number;
  lat: number;
};

export const MATCH_NUMBER_COLUMNS = [
  "area_id",
  "num",
  "point_type",
  "source",
  "rank",
  "machiaza_id",
  "lng",
  "lat",
];

/** 区域の名前 (正規化したもの) ごとの、区域の行の番号と町字 ID */
export type CityIndex = {
  areas: ReadonlyMap<string, Area>;
  areaIds: ReadonlyMap<string, readonly number[]>;
  machiazaIds: ReadonlyMap<string, readonly string[]>;
};

const point = (lng: number | null, lat: number | null) =>
  lng !== null && lat !== null ? ([lng, lat] as const) : null;

/**
 * 市区町村 1 つ分の区域の行を、正規化した名前ごとにまとめる。同じ名前に複数の行があれば、
 * ABR の町字の行 (区域そのものの点を持つものを先)、下の町字の点の平均の行、位置参照情報だけの行の順に採る
 */
export const cityIndex = (rows: readonly MatchAreaRow[]): CityIndex => {
  const order = (r: MatchAreaRow) => (r.machiaza_id !== null ? 0 : r.lng !== null ? 1 : 2);
  const sorted = rows.toSorted((a, b) => order(a) - order(b));
  const areas = new Map<string, Area>();
  const areaIds = new Map<string, number[]>();
  const machiazaIds = new Map<string, string[]>();
  for (const r of sorted) {
    const k = norm(r.name);
    const prev = areas.get(k);
    const kind = order(r);
    const nb = r.numbering_name === null ? null : norm(r.numbering_name);
    const numbering = nb !== null && nb !== k ? nb : null;
    if (prev === undefined || (kind === 0 && r.own_point && !prev.own))
      areas.set(k, {
        name: r.name,
        point: point(r.lng, r.lat),
        own: r.own_point,
        machiazaId: r.machiaza_id,
        numbering: prev?.numbering ?? numbering,
      });
    else if (prev.numbering === null && numbering !== null) areas.set(k, { ...prev, numbering });
    areaIds.set(k, [...(areaIds.get(k) ?? []), Number(r.area_id)]);
    if (r.machiaza_id !== null) machiazaIds.set(k, [...(machiazaIds.get(k) ?? []), r.machiaza_id]);
  }
  return { areas, areaIds, machiazaIds };
};

type Loaded = { rsdt: RsdtdspRow[]; parcel: ParcelRow[]; numbers: MatchNumberRow[] };

const RESIDENTIAL = new Set(["rsdt", "block"]);

/**
 * 区域の行から読んだ番号を、番号ごとに優先順の最も小さい点 1 つにまとめる。
 * 住居表示の区域 (住居表示の号・街区を持つ) では、同じ番号の地番より住居表示の点を先にする。
 * 住居表示の町字にも地番の点があり、番号が同じでも別の場所を指す
 */
export const numbersOf = ({ rsdt, parcel, numbers }: Loaded): Numbers => {
  const residential = rsdt.length > 0 || numbers.some((r) => r.point_type === "block");
  const order = (p: NumberPoint) =>
    residential && !RESIDENTIAL.has(p.pointType) ? p.rank + 100 : p.rank;
  const points = new Map<string, NumberPoint>();
  const put = (key: string, p: NumberPoint) => {
    const prev = points.get(key);
    if (prev === undefined || order(p) < order(prev)) points.set(key, p);
  };
  for (const r of rsdt) {
    const pt = point(r.lng, r.lat);
    if (pt === null) continue;
    const parts = [r.blk_num, r.rsdt_num, r.rsdt_num2].filter((x): x is string => x !== null);
    put(numberKey(parts), {
      rank: r.rsdt_id !== null ? 2 : 5,
      point: pt,
      machiazaId: r.machiaza_id,
      ids: { blk_id: r.blk_id, rsdt_id: r.rsdt_id, rsdt2_id: r.rsdt2_id },
      pointType: r.rsdt_id !== null ? "rsdt" : "block",
      source: "abr",
      parts,
    });
  }
  for (const r of parcel) {
    const pt = point(r.lng, r.lat);
    if (pt === null) continue;
    const parts = [r.prc_num1, r.prc_num2, r.prc_num3].filter((x): x is string => x !== null);
    put(numberKey(parts), {
      rank: 1,
      point: pt,
      machiazaId: r.machiaza_id,
      ids: { prc_id: r.prc_id },
      pointType: "parcel",
      source: "abr",
      parts,
    });
  }
  for (const r of numbers) {
    const parts = r.num.split("-");
    put(numberKey(parts), {
      rank: Number(r.rank),
      point: [r.lng, r.lat],
      machiazaId: r.machiaza_id,
      pointType: r.point_type,
      source: r.source,
      parts,
    });
  }
  return { has: rsdt.length + parcel.length + numbers.length > 0, points };
};
