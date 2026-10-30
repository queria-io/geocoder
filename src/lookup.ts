// 座標 → 地域コードの判定。境界タイル (scripts/build-boundary-tiles.sh) の 1 枚を読み、
// 点を含む多角形の code を返す。R2 や Worker に依らない純関数だけを置く
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

export type Level = "prefecture" | "city" | "small_area";

/** レイヤーごとに読むズーム。build-boundary-tiles.sh の -z (最大ズーム) と同じ */
export const LEVEL_ZOOM: Record<Level, number> = { prefecture: 10, city: 12, small_area: 13 };

export type TilePoint = { z: number; x: number; y: number; fx: number; fy: number };

/** Web メルカトルで点が入るタイルと、タイルの中の位置 (0〜1) */
export const tilePoint = (lng: number, lat: number, z: number): TilePoint => {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const gx = ((lng + 180) / 360) * n;
  const gy = ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n;
  const x = Math.min(Math.floor(gx), n - 1);
  const y = Math.min(Math.floor(gy), n - 1);
  return { z, x, y, fx: gx - x, fy: gy - y };
};

type Pt = { x: number; y: number };

/** 偶奇規則。穴も飛び地も、全部の輪を通して数えれば正しく出る */
const crossings = (ring: readonly Pt[], p: Pt): number =>
  ring.reduce((count, a, i) => {
    const b = ring[(i + 1) % ring.length];
    const straddles = a.y > p.y !== b.y > p.y;
    return straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x ? count + 1 : count;
  }, 0);

export const contains = (rings: readonly (readonly Pt[])[], p: Pt): boolean =>
  rings.reduce((sum, ring) => sum + crossings(ring, p), 0) % 2 === 1;

/** タイルの layer から、点 (タイル内 0〜1) を含む地物の code。無ければ null */
export const codeAt = (tile: ArrayBuffer, layer: Level, fx: number, fy: number): string | null => {
  const found = new VectorTile(new PbfReader(tile)).layers[layer];
  if (!found) return null;
  const p = { x: fx * found.extent, y: fy * found.extent };
  for (let i = 0; i < found.length; i++) {
    const feature = found.feature(i);
    if (feature.type !== 3) continue;
    const [x1, y1, x2, y2] = feature.bbox();
    if (p.x < x1 || p.x > x2 || p.y < y1 || p.y > y2) continue;
    if (contains(feature.loadGeometry(), p)) return String(feature.properties.code);
  }
  return null;
};

export type Areas = { prefecture: string | null; city: string | null; small_area: string | null };

/**
 * 町丁目のコードは頭 5 桁が市区町村、頭 2 桁が都道府県なので、町丁目が当たればそれだけで
 * 3 つ埋まる。海沿いなど町丁目に入らない点だけ、市区町村・都道府県のタイルを読みに行く
 */
export const resolveAreas = async (
  lng: number,
  lat: number,
  readTile: (t: TilePoint) => Promise<ArrayBuffer | null>,
): Promise<Areas> => {
  const at = async (level: Level) => {
    const t = tilePoint(lng, lat, LEVEL_ZOOM[level]);
    const tile = await readTile(t);
    return tile ? codeAt(tile, level, t.fx, t.fy) : null;
  };
  const small = await at("small_area");
  if (small) return { prefecture: small.slice(0, 2), city: small.slice(0, 5), small_area: small };
  const city = await at("city");
  if (city) return { prefecture: city.slice(0, 2), city, small_area: null };
  return { prefecture: await at("prefecture"), city: null, small_area: null };
};
