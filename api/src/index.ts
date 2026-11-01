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

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cors } from "hono/cors";

import { geocode, type ForwardEnv } from "./forward";
import { ErrAddressTooLong, ErrEmptyAddress } from "./normalize/input";
import { type Level, resolveAreas, type TilePoint } from "./lookup";
import { tryCatchAsync } from "./result";

export interface Env extends ForwardEnv {
  BUCKET: R2Bucket;
  /** R2 の boundaries/ に置いた境界タイルのファイル名 (queria-web の src/lib/gis/boundary-tiles.ts と同じ) */
  BOUNDARY_TILES_FILE: string;
}

/** R2 のオブジェクトを PMTiles の Source として読む (queria-web の workers/basemap と同じ) */
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
  let found = archives.get(key);
  if (!found) {
    found = new PMTiles(new R2Source(env.BUCKET, key), cache);
    archives.set(key, found);
  }
  return found;
};

// 境界タイルの元データ (queria-web の scripts/build-boundary-tiles.sh)。町丁目が当たったときは上の階層のコードも
// 町丁目のコードから取るので、出典は当たった階層の 1 つだけ
const ATTRIBUTION: Record<Level, string> = {
  small_area: "「国勢調査 境界データ（小地域）」（総務省統計局、e-Stat）を加工して作成",
  city: "「国土数値情報（行政区域データ）」（国土交通省）を加工して作成",
  prefecture: "「国土数値情報（行政区域データ）」（国土交通省）を加工して作成",
};

const json = (
  c: Context,
  status: 200 | 400 | 404 | 405 | 502,
  body: unknown,
  cacheControl: string,
) => c.json(body, status, { "Cache-Control": cacheControl });

/**
 * 緯度・経度の文字列。空や数値でないものは弾き、小数 6 桁 (約 10cm) に丸める。
 * それより細かい差は答えを変えないので、キャッシュの鍵がそろう
 */
const coord = (name: string, min: number, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1)
    .transform(Number)
    .pipe(z.number().min(min).max(max))
    .transform((n) => Math.round(n * 1e6) / 1e6)
    .openapi({ param: { name, in: "query" }, example });

const Level = z.enum(["prefecture", "city", "small_area"]).nullable();

const ReverseResult = z
  .object({
    lat: z.number(),
    lng: z.number(),
    country: z.literal("JP"),
    prefecture_code: z.string().nullable().openapi({ description: "都道府県コード (2 桁)" }),
    city_code: z.string().nullable().openapi({ description: "全国地方公共団体コードの頭 5 桁" }),
    estat_small_area_code: z
      .string()
      .nullable()
      .openapi({ description: "国勢調査の小地域コード。ABR の町字ではない" }),
    match: z.object({
      level: Level.openapi({
        description: "点が実際に入った多角形の階層。どこにも入らなければ null",
      }),
      method: z.literal("polygon"),
    }),
    source: z.object({
      boundaries: z.string().openapi({ description: "判定に使った境界タイルのファイル名" }),
      attribution: z.array(z.string()),
    }),
  })
  .openapi("ReverseResult");

const ErrorBody = z.object({ error: z.string() }).openapi("Error");

const reverseRoute = createRoute({
  method: "get",
  path: "/v1/reverse",
  summary: "座標から都道府県・市区町村・小地域のコードを返す",
  request: {
    query: z.object({
      lat: coord("lat", -90, 90, "35.6812"),
      lng: coord("lng", -180, 180, "139.7671"),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: ReverseResult } }, description: "判定の結果" },
    400: { content: { "application/json": { schema: ErrorBody } }, description: "座標がおかしい" },
    502: {
      content: { "application/json": { schema: ErrorBody } },
      description: "境界タイルを読めない",
    },
  },
});

const reverse = async (lat: number, lng: number, env: Env) => {
  const readTile = async ({ z, x, y }: TilePoint) =>
    (await archive(env).getZxy(z, x, y))?.data ?? null;
  const { level, ...codes } = await resolveAreas(lng, lat, readTile);
  return {
    lat,
    lng,
    country: "JP" as const,
    ...codes,
    match: { level, method: "polygon" as const },
    source: {
      boundaries: env.BOUNDARY_TILES_FILE,
      attribution: level === null ? [] : [ATTRIBUTION[level]],
    },
  };
};

const app = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook: (result, c) =>
    result.success
      ? undefined
      : json(
          c,
          400,
          {
            error: result.error.issues.some((i) => i.path.includes("address"))
              ? "address を 1〜100 文字で渡してください"
              : "lat と lng を数値で渡してください",
          },
          "no-store",
        ),
});

app.use("*", cors({ origin: "*", allowMethods: ["GET"] }));

app.openapi(reverseRoute, async (c) => {
  const { lat, lng } = c.req.valid("query");
  // 鍵は丸めた座標と境界タイルのファイル名から作る。元の URL のままだと書き方の違う同じ座標や
  // 余計なクエリで項目が割れ、タイルを向け替えても古い答えが 1 日残る
  const url = new URL(c.req.url);
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set("lat", String(lat));
  cacheUrl.searchParams.set("lng", String(lng));
  cacheUrl.searchParams.set("tiles", c.env.BOUNDARY_TILES_FILE);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  // 置いてあるのは下で 200 として返したものそのまま
  if (cached) return cached as never;
  const result = await tryCatchAsync(() => reverse(lat, lng, c.env));
  if (!result.ok) {
    console.error("geocoder: reverse", result.error);
    return c.json({ error: "境界タイルを読めませんでした" }, 502, { "Cache-Control": "no-store" });
  }
  const response = c.json(result.value, 200, { "Cache-Control": "public, max-age=86400" });
  c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
});

const StructuredAddress = z
  .object(
    Object.fromEntries(
      [
        "pref",
        "county",
        "city",
        "ward",
        "kyoto_st",
        "oaza_cho",
        "chome",
        "koaza",
        "machiaza_dist",
        "blk_num",
        "rsdt_num",
        "rsdt_num2",
        "prc_num1",
        "prc_num2",
        "prc_num3",
      ].map((k) => [k, z.string().nullable()]),
    ),
  )
  .openapi("StructuredAddress");

const GeocodeResult = z
  .object({
    matched_address: z.string().openapi({ description: "当たった住所の表記" }),
    unmatched_address: z
      .array(z.string())
      .nullable()
      .openapi({ description: "当たらずに残った部分 (番号・建物名など)。残りが無ければ null" }),
    match_level: z
      .enum([
        "unknown",
        "pref",
        "city",
        "machiaza",
        "machiaza_detail",
        "rsdtdsp_blk",
        "rsdtdsp_rsdt",
        "parcel",
      ])
      .openapi({ description: "当たった階層" }),
    score: z.number().openapi({ description: "1 はぴったりの一致。あいまい一致はそれより小さい" }),
    lg_code: z.string().nullable().openapi({ description: "全国地方公共団体コード (6 桁)" }),
    machiaza_id: z.string().nullable().openapi({ description: "ABR の町字 ID (7 桁)" }),
    rsdt_addr_flg: z
      .string()
      .nullable()
      .openapi({ description: "'1' は住居表示の町字。決まらなければ null" }),
    structured_address: StructuredAddress,
    lng: z.number().nullable(),
    lat: z.number().nullable(),
  })
  .openapi("GeocodeResult");

const geocodeRoute = createRoute({
  method: "get",
  path: "/v1/geocode",
  summary: "住所から町字と代表点を返す",
  request: {
    query: z.object({
      address: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .openapi({ param: { name: "address", in: "query" }, example: "東京都千代田区紀尾井町1-3" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ results: z.array(GeocodeResult) }) } },
      description: "当てた結果。強い順",
    },
    400: {
      content: { "application/json": { schema: ErrorBody } },
      description: "住所が空か長すぎる",
    },
    502: { content: { "application/json": { schema: ErrorBody } }, description: "表を読めない" },
  },
});

app.openapi(geocodeRoute, async (c) => {
  const { address } = c.req.valid("query");
  const result = await tryCatchAsync(() => geocode(c.env, address, 1));
  if (!result.ok) {
    if (result.error instanceof ErrEmptyAddress || result.error instanceof ErrAddressTooLong)
      return c.json({ error: "address を 1〜100 文字で渡してください" }, 400, {
        "Cache-Control": "no-store",
      });
    console.error("geocoder: geocode", result.error);
    return c.json({ error: "住所の表を読めませんでした" }, 502, { "Cache-Control": "no-store" });
  }
  const results = result.value.map((r) => ({
    matched_address: r.matched_address,
    unmatched_address: r.unmatched_address,
    match_level: r.match_level,
    score: r.score,
    lg_code: r.ids.lg_code,
    machiaza_id: r.ids.machiaza_id,
    rsdt_addr_flg: r.ids.rsdt_addr_flg,
    structured_address: r.structured_address,
    lng: r.coordinates?.[0] ?? null,
    lat: r.coordinates?.[1] ?? null,
  }));
  return c.json({ results }, 200, { "Cache-Control": "public, max-age=86400" });
});

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Queria Geocoder", version: "0.1.0" },
});

app.all("/v1/reverse", (c) => c.body("Method Not Allowed", 405, { Allow: "GET" }));
app.all("/v1/geocode", (c) => c.body("Method Not Allowed", 405, { Allow: "GET" }));
app.notFound((c) => json(c, 404, { error: "not found" }, "no-store"));

export default app satisfies ExportedHandler<Env>;
