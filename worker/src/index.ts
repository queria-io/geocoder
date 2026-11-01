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

import {
  ABR_ATTRIBUTION,
  coordinatesLevel,
  csvColumns,
  type Extras,
  type Include,
  forwardAnswer,
  forwardFeature,
  INCLUDES,
  lgCodeOf,
  meshCodes,
  parseInclude,
  parseNames,
  SMALL_AREA_ATTRIBUTION,
  toCsv,
  versionOf,
} from "./answer";
import { geocode, nearby, type ForwardEnv } from "./forward";
import { ISJ_ATTRIBUTION, PARCEL_PARENT } from "./isj";
import { ErrAddressTooLong, ErrEmptyAddress } from "./normalize/input";
import { type Level, resolveAreas, type TilePoint } from "./lookup";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "./model/model";
import { tryCatchAsync } from "./result";

export interface Env extends ForwardEnv {
  BUCKET: R2Bucket;
  /** R2 の boundaries/ に置いた境界タイルのファイル名 (queria-web の src/lib/gis/boundary-tiles.ts と同じ) */
  BOUNDARY_TILES_FILE: string;
  /** 町字などの表のバージョン (geocoder データセットを作った日)。表を作り直したら書き換える */
  DATA_VERSION: string;
  /** IP ごとの回数の上限。費用を守るためのもので、ふつうの使い方では当たらない高さにする */
  LIMITER?: RateLimit;
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
  status: 200 | 400 | 404 | 405 | 429 | 502,
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
    // 入力は文字列だが、仕様書には数値として書く (利用者が仕様書から SDK を作るとき困らないように)
    .openapi({ param: { name, in: "query" }, type: "number", example: Number(example) } as never);

const Level = z.enum(["prefecture", "city", "small_area"]).nullable();

const ErrorBody = z.object({ error: z.string() }).openapi("Error");

const Source = z
  .object({
    version: z.string().openapi({ description: "答えに使ったデータのバージョン" }),
    attribution: z
      .array(z.string())
      .openapi({ description: "出典の表示。答えを載せるときは一緒に載せる" }),
  })
  .openapi("Source");

const includeParam = (names: readonly string[]) =>
  z
    .string()
    .optional()
    .openapi({
      param: {
        name: "include",
        in: "query",
        description: `足す項目の組をカンマ区切りで (${names.join("・")})`,
      },
      example: names[0],
    });

const ReverseCodes = z
  .object({
    prefecture_code: z.string().nullable().openapi({ description: "都道府県コード (2 桁)" }),
    city_code: z.string().nullable().openapi({ description: "全国地方公共団体コードの頭 5 桁" }),
    mesh_1km: z.string().openapi({ description: "標準地域メッシュ (3 次、8 桁)" }),
    mesh_500m: z.string().openapi({ description: "2 分の 1 地域メッシュ (9 桁)" }),
    mesh_250m: z.string().openapi({ description: "4 分の 1 地域メッシュ (10 桁)" }),
  })
  .openapi("ReverseCodes");

const REVERSE_INCLUDES = ["address", "codes"] as const;

const ReverseAddress = z
  .object({
    matched_address: z.string().openapi({ description: "近くの点の住所" }),
    match_level: z.string().openapi({
      description: "住所がどこまで細かいか (machiaza・machiaza_detail・rsdtdsp_blk・rsdtdsp_rsdt)",
    }),
    lat: z.number().openapi({ description: "その住所の点の緯度" }),
    lng: z.number().openapi({ description: "その住所の点の経度" }),
    distance_m: z.number().openapi({ description: "渡した座標からその点までの距離 (m)" }),
    machiaza_id: z.string().openapi({ description: "ABR の町字 ID (7 桁)" }),
  })
  .openapi("ReverseAddress");

const ReverseResult = z
  .object({
    lat: z.number(),
    lng: z.number(),
    lg_code: z
      .string()
      .nullable()
      .openapi({ description: "全国地方公共団体コード (6 桁、検査数字つき)" }),
    estat_small_area_code: z
      .string()
      .nullable()
      .openapi({ description: "国勢調査の小地域コード。ABR の町字ではない" }),
    match_level: Level.openapi({
      description: "点が実際に入った区画の階層。どこにも入らなければ null",
    }),
    address: ReverseAddress.nullable().optional().openapi({
      description:
        "include=address のときだけ。市区町村の中でいちばん近い町字・街区・住居の点の住所。町字の形は見ていないので、境目の近くでは隣の町字になることがある。市区町村に入らなければ null",
    }),
    codes: ReverseCodes.optional().openapi({ description: "include=codes のときだけ" }),
    source: Source,
  })
  .openapi("ReverseResult");

const reverseRoute = createRoute({
  method: "get",
  path: "/v1/reverse",
  summary: "座標から市区町村・小地域のコードを返す",
  request: {
    query: z.object({
      lat: coord("lat", -90, 90, "35.6812"),
      lng: coord("lng", -180, 180, "139.7671"),
      include: includeParam(REVERSE_INCLUDES),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: ReverseResult } }, description: "判定の結果" },
    400: { content: { "application/json": { schema: ErrorBody } }, description: "座標がおかしい" },
    429: {
      content: { "application/json": { schema: ErrorBody } },
      description: "呼び出しが多すぎる",
    },
    502: {
      content: { "application/json": { schema: ErrorBody } },
      description: "境界タイルか住所の表を読めない",
    },
  },
});

const readTileOf =
  (env: Env) =>
  async ({ z, x, y }: TilePoint) =>
    (await archive(env).getZxy(z, x, y))?.data ?? null;

const reverse = async (lat: number, lng: number, groups: ReadonlySet<string>, env: Env) => {
  const { level, prefecture_code, city_code, estat_small_area_code } = await resolveAreas(
    lng,
    lat,
    readTileOf(env),
  );
  const lg_code = lgCodeOf(city_code);
  const withAddress = groups.has("address");
  const address = withAddress && lg_code ? await nearby(env, lg_code, lat, lng) : null;
  return {
    lat,
    lng,
    lg_code,
    estat_small_area_code,
    match_level: level,
    ...(withAddress ? { address } : {}),
    ...(groups.has("codes")
      ? { codes: { prefecture_code, city_code, ...meshCodes(lat, lng) } }
      : {}),
    source: {
      version: versionOf(env.BOUNDARY_TILES_FILE),
      attribution: [
        ...(level === null ? [] : [ATTRIBUTION[level]]),
        ...(address ? [ABR_ATTRIBUTION] : []),
      ],
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
              : result.error.issues.some((i) => i.path.includes("limit"))
                ? "limit は 1〜10 の整数で渡してください"
                : result.error.issues.some((i) => i.path.includes("format"))
                  ? "format は json・geojson・csv のどれかで渡してください"
                  : result.error.issues.some((i) => i.path.includes("addresses"))
                    ? `addresses に住所の文字列を 1〜${BATCH_MAX} 件の配列で渡してください`
                    : "lat と lng を数値で渡してください",
          },
          "no-store",
        ),
});

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"] }));

// 鍵は呼んだ元の IP。上限は Cloudflare の拠点ごとに数えるので目安
app.use("/v1/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip");
  if (c.env.LIMITER && ip && !(await c.env.LIMITER.limit({ key: ip })).success)
    return json(
      c,
      429,
      { error: "呼び出しが多すぎます。少し待ってから呼んでください" },
      "no-store",
    );
  return next();
});

app.openapi(reverseRoute, async (c) => {
  const { lat, lng, include } = c.req.valid("query");
  const groups = parseNames(include, REVERSE_INCLUDES);
  if (groups === null)
    return json(c, 400, { error: "include に使えるのは address・codes です" }, "no-store") as never;
  // 鍵は丸めた座標と境界タイルのファイル名から作る。元の URL のままだと書き方の違う同じ座標や
  // 余計なクエリで項目が割れ、タイルを向け替えても古い答えが 1 日残る
  const url = new URL(c.req.url);
  const cacheUrl = new URL(url.origin + url.pathname);
  cacheUrl.searchParams.set("lat", String(lat));
  cacheUrl.searchParams.set("lng", String(lng));
  cacheUrl.searchParams.set("tiles", c.env.BOUNDARY_TILES_FILE);
  cacheUrl.searchParams.set("include", [...groups].sort().join(","));
  if (groups.has("address")) cacheUrl.searchParams.set("data", c.env.DATA_VERSION);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
  const cached = await caches.default.match(cacheKey);
  // 置いてあるのは下で 200 として返したものそのまま
  if (cached) return cached as never;
  const result = await tryCatchAsync(() => reverse(lat, lng, groups, c.env));
  if (!result.ok) {
    console.error("geocoder: reverse", result.error);
    return c.json({ error: "境界タイルか住所の表を読めませんでした" }, 502, {
      "Cache-Control": "no-store",
    });
  }
  const response = c.json(result.value, 200, { "Cache-Control": "public, max-age=86400" });
  c.executionCtx.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
});

const nullableStrings = (keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, z.string().nullable()]));

const StructuredAddress = z
  .object(
    nullableStrings([
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
    ]),
  )
  .openapi("StructuredAddress", { description: "住所の区切り。項目名は abr-geocoder と同じ" });

const Ids = z
  .object(
    nullableStrings([
      "lg_code",
      "machiaza_id",
      "rsdt_addr_flg",
      "blk_id",
      "rsdt_id",
      "rsdt2_id",
      "prc_id",
    ]),
  )
  .openapi("Ids", {
    description:
      "ABR の ID。rsdt_addr_flg は '1' が住居表示、'0' が地番の町字、決まらなければ null",
  });

const MATCH_LEVELS = [
  "pref",
  "city",
  "machiaza",
  "machiaza_detail",
  "rsdtdsp_blk",
  "rsdtdsp_rsdt",
  "parcel",
] as const;
const MatchLevel = z.enum(MATCH_LEVELS);
const CoordinatesLevel = z.enum([...MATCH_LEVELS, "parcel_parent"]);

const ForwardCodes = z
  .object({
    prefecture_code: z.string().nullable().openapi({ description: "都道府県コード (2 桁)" }),
    city_code: z
      .string()
      .nullable()
      .openapi({ description: "全国地方公共団体コードの頭 5 桁。都道府県までなら null" }),
    postal_code: z.string().nullable().openapi({ description: "町字の郵便番号 (7 桁)" }),
    mesh_1km: z.string().nullable().openapi({ description: "標準地域メッシュ (3 次、8 桁)" }),
    mesh_500m: z.string().nullable().openapi({ description: "2 分の 1 地域メッシュ (9 桁)" }),
    mesh_250m: z.string().nullable().openapi({ description: "4 分の 1 地域メッシュ (10 桁)" }),
  })
  .openapi("ForwardCodes");

const optional = <T extends z.ZodTypeAny>(t: T, group: string) =>
  t.optional().openapi({ description: `include=${group} のときだけ` });

const smallArea = z
  .string()
  .nullable()
  .openapi({ description: "座標が入る国勢調査の小地域コード。include=small_area のときだけ" });

const GeocodeResult = z
  .object({
    matched_address: z.string().openapi({ description: "当たった住所の表記" }),
    unmatched_address: z
      .array(z.string())
      .nullable()
      .openapi({ description: "当たらずに残った部分 (番号・建物名など)。残りが無ければ null" }),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    match_level: MatchLevel.openapi({
      description:
        "住所がどこまで当たったか。rsdtdsp_rsdt は号、rsdtdsp_blk は街区、parcel は地番、machiaza_detail は小字、machiaza は町字",
    }),
    coordinates_level: CoordinatesLevel.nullable().openapi({
      description:
        "座標を取った点の段。値の意味は match_level と同じ。番号まで当たってもその点に座標が無ければ町字の代表点で埋め、machiaza になる。parcel_parent は地番の親番 (「28番地10」の「28」) の点で、国交省の街区レベル位置参照情報から取る (ABR に地番の点が無いとき)。どれも代表点で、建物の位置ではない",
    }),
    lg_code: z
      .string()
      .nullable()
      .openapi({ description: "全国地方公共団体コード (6 桁、検査数字つき)" }),
    score: optional(
      z.number().openapi({ description: "候補の並べ替えに使う値。1 はぴったりの一致" }),
      "match",
    ),
    structured_address: optional(StructuredAddress, "structured_address"),
    ids: optional(Ids, "ids"),
    codes: optional(ForwardCodes, "codes"),
    estat_small_area_code: smallArea.optional(),
  })
  .openapi("GeocodeResult");

const GeocodeResponse = z
  .object({ results: z.array(GeocodeResult).openapi({ description: "強い順" }), source: Source })
  .openapi("GeocodeResponse");

const GeocodeFeatureCollection = z
  .object({
    type: z.literal("FeatureCollection"),
    query: z.object({ address: z.string(), limit: z.number() }),
    result_info: z.object({
      count: z.number(),
      limit: z.number(),
      api_version: z.string(),
      db_version: z.string(),
    }),
    features: z.array(
      z.object({
        type: z.literal("Feature"),
        geometry: z
          .object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]) })
          .nullable(),
        properties: z.object({
          matched_address: z.string(),
          unmatched_address: z.array(z.string()).nullable(),
          score: z.number(),
          match_level: MatchLevel,
          coordinates_level: CoordinatesLevel.nullable(),
          ids: Ids,
          structured_address: StructuredAddress,
          codes: optional(ForwardCodes, "codes"),
          estat_small_area_code: smallArea.optional(),
        }),
      }),
    ),
    attribution: z.array(z.string()).openapi({ description: "出典の表示" }),
  })
  .openapi("GeocodeFeatureCollection", {
    description: "format=geojson のとき。abr-geocoder の /geocode と同じ形",
  });

const API_VERSION = "0.2.0-beta";

const geocodeRoute = createRoute({
  method: "get",
  path: "/v1/geocode",
  summary: "住所から座標とコードを返す",
  request: {
    query: z.object({
      address: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .openapi({
          param: { name: "address", in: "query", description: "住所。URL エンコードして渡す" },
          example: "東京都千代田区紀尾井町1-3",
        }),
      limit: z
        .string()
        .regex(/^\d+$/)
        .transform(Number)
        .pipe(z.number().int().min(1).max(10))
        .optional()
        .openapi({
          param: { name: "limit", in: "query", description: "返す候補の数の上限 (1〜10、既定 1)" },
          type: "integer",
          example: 1,
        } as never),
      include: includeParam(INCLUDES),
      format: z
        .enum(["json", "geojson", "csv"])
        .optional()
        .openapi({
          param: {
            name: "format",
            in: "query",
            description:
              "json (既定)・geojson (abr-geocoder と同じ FeatureCollection)・csv (1 件 1 行、BOM 付き UTF-8。出典は X-Attribution ヘッダ)",
          },
        }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: GeocodeResponse },
        "application/geo+json": { schema: GeocodeFeatureCollection },
        "text/csv": {
          schema: z.string().openapi({
            description: "1 件 1 行。入れ子の項目は structured_address.pref のような列にほどく",
          }),
        },
      },
      description: "当てた結果。当たらなければ results (features) が空",
    },
    400: {
      content: { "application/json": { schema: ErrorBody } },
      description: "住所が空か長すぎる、指定がおかしい",
    },
    429: {
      content: { "application/json": { schema: ErrorBody } },
      description: "呼び出しが多すぎる",
    },
    502: { content: { "application/json": { schema: ErrorBody } }, description: "表を読めない" },
  },
});

const EMPTY_RESULT: MatchedResult = {
  matched_address: "",
  unmatched_address: null,
  match_level: "unknown",
  score: 0,
  ids: emptyIDs(),
  structured_address: emptySA(),
  coordinates: null,
  machiaza: emptyMachiaza(),
};
const NO_EXTRAS: Extras = { postal_code: null, estat_small_area_code: null };

const smallAreaOf = async (env: Env, r: MatchedResult) =>
  r.coordinates === null
    ? null
    : (await resolveAreas(r.coordinates[0], r.coordinates[1], readTileOf(env)))
        .estat_small_area_code;

/** 1 つの住所を当てて、頼まれた項目のための値も引く */
const answer = async (env: Env, address: string, limit: number, groups: ReadonlySet<Include>) => {
  const { results, postalCode } = await geocode(env, address, limit);
  const extras = await Promise.all(
    results.map(async (r): Promise<Extras> => ({
      postal_code: groups.has("codes") ? await postalCode(r) : null,
      estat_small_area_code: groups.has("small_area") ? await smallAreaOf(env, r) : null,
    })),
  );
  return results.map((r, i) => [r, extras[i]] as const);
};

/** levels は答えごとの coordinates_level。位置参照情報の点を使った答えがあれば、その出典も足す */
const attributionFor = (groups: ReadonlySet<Include>, levels: readonly (string | null)[]) => [
  ABR_ATTRIBUTION,
  ...(levels.includes(PARCEL_PARENT) ? [ISJ_ATTRIBUTION] : []),
  ...(groups.has("small_area") ? [SMALL_AREA_ATTRIBUTION] : []),
];

app.openapi(geocodeRoute, async (c) => {
  const { address, limit = 1, include, format } = c.req.valid("query");
  const groups = parseInclude(include);
  if (groups === null)
    return json(
      c,
      400,
      { error: `include に使えるのは ${INCLUDES.join(",")} です` },
      "no-store",
    ) as never;
  const result = await tryCatchAsync(() => answer(c.env, address, limit, groups));
  if (!result.ok) {
    if (result.error instanceof ErrEmptyAddress || result.error instanceof ErrAddressTooLong)
      return json(c, 400, { error: "address を 1〜100 文字で渡してください" }, "no-store") as never;
    console.error("geocoder: geocode", result.error);
    return json(c, 502, { error: "住所の表を読めませんでした" }, "no-store") as never;
  }
  const version = c.env.DATA_VERSION;
  const attribution = attributionFor(
    groups,
    result.value.map(([r]) => coordinatesLevel(r)),
  );
  const headers = { "Cache-Control": "public, max-age=86400" };
  if (format === "geojson") {
    const body = {
      type: "FeatureCollection",
      query: { address, limit },
      result_info: {
        count: result.value.length,
        limit,
        api_version: API_VERSION,
        db_version: version,
      },
      features: result.value.map(([r, x]) => forwardFeature(r, groups, x)),
      attribution,
    };
    return c.body(JSON.stringify(body), 200, {
      ...headers,
      "Content-Type": "application/geo+json",
    }) as never;
  }
  const results = result.value.map(([r, x]) => forwardAnswer(r, groups, x));
  if (format === "csv") {
    // 行が無くても列名は出す。列は頼まれた組で決まる
    const columns = csvColumns(forwardAnswer(EMPTY_RESULT, groups, NO_EXTRAS));
    return c.body(toCsv(columns, results), 200, {
      ...headers,
      "Content-Type": "text/csv; charset=utf-8",
      // ヘッダには日本語を書けないので、出典は URL エンコードして渡す
      "X-Attribution": attribution.map(encodeURIComponent).join(","),
    }) as never;
  }
  return c.json({ results, source: { version, attribution } }, 200, headers) as never;
});

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Queria Geocoder",
    version: API_VERSION,
    description: [
      "日本の住所と座標・地域コードを相互に引く無料の API。ベータの間は答えの形を変えることがある。答えを載せるときは source.attribution の出典も一緒に載せる",
      "地図で試す画面と、CSV をまとめて変換する画面は [queria.io/geocoder](https://queria.io/geocoder) にある",
    ].join("\n\n"),
  },
});

// 1 件ごとに市区町村の町字を読むので、市区町村がばらばらだと 100 件で CPU の上限 (30 秒) を超えた。町字の表の行グループを小さくするまでは 25 件にする
const BATCH_MAX = 25;

const batchRoute = createRoute({
  method: "post",
  path: "/v1/batch",
  summary: "住所をまとめて当てる",
  description: `1 回に ${BATCH_MAX} 件まで。回数の上限は 1 回の呼び出しで 1 回と数える`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              addresses: z.array(z.string()).min(1).max(BATCH_MAX),
              include: z.string().optional().openapi({ description: "/v1/geocode と同じ" }),
            })
            .openapi("BatchRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              results: z.array(GeocodeResult.nullable()).openapi({
                description: "addresses と同じ順。当たらない住所・空や長すぎる住所は null",
              }),
              source: Source,
            })
            .openapi("BatchResponse"),
        },
      },
      description: "住所ごとに一番強い 1 件",
    },
    400: { content: { "application/json": { schema: ErrorBody } }, description: "指定がおかしい" },
    429: {
      content: { "application/json": { schema: ErrorBody } },
      description: "呼び出しが多すぎる",
    },
    502: { content: { "application/json": { schema: ErrorBody } }, description: "表を読めない" },
  },
});

app.openapi(batchRoute, async (c) => {
  const { addresses, include } = c.req.valid("json");
  const groups = parseInclude(include);
  if (groups === null)
    return json(
      c,
      400,
      { error: `include に使えるのは ${INCLUDES.join(",")} です` },
      "no-store",
    ) as never;
  const one = async (address: string) => {
    const r = await tryCatchAsync(() => answer(c.env, address, 1, groups));
    if (r.ok) return r.value[0] ? forwardAnswer(r.value[0][0], groups, r.value[0][1]) : null;
    if (r.error instanceof ErrEmptyAddress || r.error instanceof ErrAddressTooLong) return null;
    throw r.error;
  };
  // 1 件ずつ当てる。同じ市区町村の住所が続けば、読んだ表を使い回せる
  const result = await tryCatchAsync(async () => {
    const out = [];
    for (const a of addresses) out.push(await one(a));
    return out;
  });
  if (!result.ok) {
    console.error("geocoder: batch", result.error);
    return json(c, 502, { error: "住所の表を読めませんでした" }, "no-store") as never;
  }
  return c.json(
    {
      results: result.value,
      source: {
        version: c.env.DATA_VERSION,
        attribution: attributionFor(
          groups,
          result.value.map((a) => a?.coordinates_level ?? null),
        ),
      },
    },
    200,
    { "Cache-Control": "no-store" },
  ) as never;
});

// 仕様書 (/openapi.json) を人が読める形で出す。項目の説明は手で書かず、仕様書から作る
const DOCS_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Queria Geocoder API</title>
</head>
<body>
<script id="api-reference" data-url="/openapi.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0"></script>
</body>
</html>`;

// ここは API と仕様書だけ。/ は仕様書を見せる
app.get("/", (c) => c.redirect("/docs", 302));
app.get("/docs", (c) => c.html(DOCS_HTML, 200, { "Cache-Control": "public, max-age=3600" }));

app.all("/v1/reverse", (c) => c.body("Method Not Allowed", 405, { Allow: "GET" }));
app.all("/v1/geocode", (c) => c.body("Method Not Allowed", 405, { Allow: "GET" }));
app.all("/v1/batch", (c) => c.body("Method Not Allowed", 405, { Allow: "POST" }));
app.notFound((c) => json(c, 404, { error: "not found" }, "no-store"));

export default app satisfies ExportedHandler<Env>;
