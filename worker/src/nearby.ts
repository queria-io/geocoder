// 座標 → 近くの住所。市区町村の町字の代表点から近いものを選び、その町字の街区・住居の点まで寄せる。
// 町字の形は持っていないので、境目の近くでは隣の町字を返すことがある。返すのは「いちばん近い点の住所」
import { DetermineMatchLevel, FormatAddress, type MatchLevel } from "./model/model";
import type { RsdtdspRow } from "./repository/rsdtdsp";
import { BasicResultToNormalized, type BasicResult } from "./repository/types";

export type Nearby = {
  matched_address: string;
  match_level: MatchLevel;
  /** 寄せた先の点 */
  lat: number;
  lng: number;
  /** 渡された座標から寄せた先の点までの距離 (m) */
  distance_m: number;
  machiaza_id: string;
};

/** 町字の候補の数。代表点だけで選ぶと隣の町字を取りやすいので、近い順に何個か番号の点まで見る */
const TOWNS = 3;
/** 番号の点がこれより遠ければ、町字の代表点のまま返す */
const POINT_MAX_M = 150;

/** 正距円筒で近似した距離 (m)。数百 m の比べ合いには足りる */
export const distanceM = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const k = Math.PI / 180;
  const x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.round(Math.hypot(x, y) * 6_371_000);
};

type Point = { lat: number; lng: number; d: number };

const withPoint =
  <T extends { lat: number | null }>(lng: (t: T) => number | null) =>
  (lat: number, at: number) =>
  (t: T): (T & Point) | null => {
    const tLng = lng(t);
    return t.lat === null || tLng === null
      ? null
      : { ...t, lat: t.lat, lng: tLng, d: distanceM(lat, at, t.lat, tLng) };
  };

const townPoint = withPoint<BasicResult>((t) => t.lon);
const rowPoint = withPoint<RsdtdspRow>((r) => r.lng);

const byDistance = (a: { d: number }, b: { d: number }) => a.d - b.d;
const present = <T>(x: T | null): x is T => x !== null;

export const nearestAddress = async (
  towns: BasicResult[],
  loadRows: (lgCode: string, machiazaId: string) => Promise<RsdtdspRow[]>,
  lat: number,
  lng: number,
): Promise<Nearby | null> => {
  const near = towns.map(townPoint(lat, lng)).filter(present).sort(byDistance).slice(0, TOWNS);
  if (near.length === 0) return null;
  const points = await Promise.all(
    near.map(async (t) =>
      t.rsdtdspCount === 0
        ? []
        : (await loadRows(t.lgCode, t.machiazaId))
            .map(rowPoint(lat, lng))
            .filter(present)
            .map((row) => ({ town: t, row, d: row.d })),
    ),
  );
  const best = points.flat().sort(byDistance)[0];
  const town = near[0];
  if (!best || best.d > POINT_MAX_M) {
    const r = BasicResultToNormalized(town);
    return {
      matched_address: r.matched_address,
      match_level: r.match_level,
      lat: town.lat,
      lng: town.lng,
      distance_m: town.d,
      machiaza_id: town.machiazaId,
    };
  }
  const base = BasicResultToNormalized(best.town);
  const { row } = best;
  return {
    matched_address: FormatAddress({
      ...base.structured_address,
      blk_num: row.blk_num,
      rsdt_num: row.rsdt_num,
      rsdt_num2: row.rsdt_num2,
    }),
    match_level: DetermineMatchLevel({
      ...base.ids,
      blk_id: row.blk_id,
      rsdt_id: row.rsdt_id,
      rsdt2_id: row.rsdt2_id,
    }),
    lat: row.lat,
    lng: row.lng,
    distance_m: row.d,
    machiaza_id: best.town.machiazaId,
  };
};
