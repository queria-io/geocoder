// 座標から都道府県・市区町村・町丁目のコードを返す逆ジオコーダー (README.md)。
//
// DuckDB もデータベースも使わない。地図用に R2 へ置いた境界の PMTiles から、点の入るタイルを
// Range で 1 枚だけ読み、点を含む多角形を JS で探す。待機中の費用はかからず、1 回の問い合わせは
// R2 の読み 1〜2 回と数ミリ秒の計算で済む
import {
  EtagMismatch,
  PMTiles,
  type RangeResponse,
  ResolvedValueCache,
  type Source,
} from "pmtiles";

import { resolveAreas, type TilePoint } from "./lookup";

export interface Env {
  BUCKET: R2Bucket;
  /** R2 の boundaries/ に置いた境界タイルのファイル名 (src/lib/gis/boundary-tiles.ts と同じ) */
  BOUNDARY_TILES_FILE: string;
}

const CORS = { "Access-Control-Allow-Origin": "*" };

/** R2 のオブジェクトを PMTiles の Source として読む (workers/basemap と同じ) */
class R2Source implements Source {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
  ) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string) {
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
      onlyIf: etag ? { etagMatches: etag } : undefined,
    });
    if (!object) throw new Error(`not found: ${this.key}`);
    if (!("body" in object)) throw new EtagMismatch();
    return { data: await object.arrayBuffer(), etag: object.etag } satisfies RangeResponse;
  }
}

// ヘッダとディレクトリは isolate の中で使い回す。問い合わせごとに読み直すと R2 の往復が 3 回増える
const cache = new ResolvedValueCache(25, undefined);
const archives = new Map<string, PMTiles>();

const archive = (env: Env): PMTiles => {
  const key = `boundaries/${env.BOUNDARY_TILES_FILE}`;
  const found = archives.get(key) ?? new PMTiles(new R2Source(env.BUCKET, key), cache);
  archives.set(key, found);
  return found;
};

const json = (status: number, body: unknown, cacheControl: string): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": cacheControl, ...CORS },
  });

/** 小数 6 桁 (約 10cm) より細かい差は答えを変えないので、キャッシュの鍵をそろえる */
const parseCoord = (value: string | null, min: number, max: number): number | null => {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 1e6) / 1e6 : null;
};

const reverse = async (url: URL, env: Env): Promise<Response> => {
  const lat = parseCoord(url.searchParams.get("lat"), -90, 90);
  const lng = parseCoord(url.searchParams.get("lng"), -180, 180);
  if (lat === null || lng === null) {
    return json(400, { error: "lat と lng を数値で渡してください" }, "no-store");
  }
  const readTile = async ({ z, x, y }: TilePoint) =>
    (await archive(env).getZxy(z, x, y))?.data ?? null;
  const areas = await resolveAreas(lng, lat, readTile);
  return json(200, { lat, lng, ...areas }, "public, max-age=86400");
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET", ...CORS },
      });
    }
    const url = new URL(request.url);
    if (url.pathname !== "/v1/reverse") return json(404, { error: "not found" }, "no-store");

    const cached = await caches.default.match(request);
    if (cached) return cached;
    try {
      const response = await reverse(url, env);
      if (response.status === 200) ctx.waitUntil(caches.default.put(request, response.clone()));
      return response;
    } catch (e) {
      console.error("geocoder: reverse", e);
      return json(502, { error: "境界タイルを読めませんでした" }, "no-store");
    }
  },
} satisfies ExportedHandler<Env>;
