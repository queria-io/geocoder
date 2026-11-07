// 座標から都道府県・市区町村・町丁目のコードを返す逆ジオコーダー (README.md)。
//
// DuckDB もデータベースも使わない。地図用に R2 へ置いた境界の PMTiles から、点の入るタイルを
// Range で 1 枚だけ読み、点を含む多角形を JS で探す。待機中の費用はかからず、1 回の問い合わせは
// R2 の読み 1〜2 回と数ミリ秒の計算で済む
import { logEntry, type RequestLogEntry, type RequestLogEnv, sendLog } from "./request_log";
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
  ISJ_ATTRIBUTION,
  FORMER_CITY_ATTRIBUTION,
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
import { dataVersion, geocode, nearby, type ForwardEnv } from "./forward";
import { ErrAddressTooLong, ErrEmptyAddress } from "./normalize/input";
import { type Level, resolveAreas, type TilePoint } from "./lookup";
import { emptyIDs, emptyMachiaza, emptySA, type MatchedResult } from "./model/model";
import { tryCatchAsync } from "./result";

export interface Env extends ForwardEnv, RequestLogEnv {
  BUCKET: R2Bucket;
  /** R2 の boundaries/ に置いた境界タイルのファイル名 (queria-web の src/lib/gis/boundary-tiles.ts と同じ) */
  BOUNDARY_TILES_FILE: string;
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
    version: z.string().openapi({ description: "結果に使ったデータのバージョン" }),
    attribution: z
      .array(z.string())
      .openapi({ description: "出典の表示。結果を公開するときは一緒に表示する" }),
  })
  .openapi("Source");

/** names は項目の組の名前と中身 */
const includeParam = (names: Readonly<Record<string, string>>) =>
  z
    .string()
    .optional()
    .openapi({
      param: {
        name: "include",
        in: "query",
        description: [
          "結果に含める項目の組をカンマ区切りで指定する。",
          ...Object.entries(names).map(([k, v]) => `- ${k}: ${v}`),
        ].join("\n"),
      },
      example: Object.keys(names)[0],
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
  summary: "座標から市区町村・小地域のコードを取得する",
  request: {
    query: z.object({
      lat: coord("lat", -90, 90, "35.6812"),
      lng: coord("lng", -180, 180, "139.7671"),
      include: includeParam({
        address: "近くの町字・街区・住居の住所 (address)",
        codes: "都道府県コード・市区町村コード・地域メッシュ (codes)",
      }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: ReverseResult } }, description: "判定の結果" },
    400: {
      content: { "application/json": { schema: ErrorBody } },
      description: "座標が範囲外か数値でない",
    },
    429: {
      content: { "application/json": { schema: ErrorBody } },
      description: "リクエストの回数が上限 (1 分に 300 回) を超えた",
    },
    502: {
      content: { "application/json": { schema: ErrorBody } },
      description: "境界か住所のデータを読み込めない",
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
            error:
              c.req.path.endsWith("/batch") &&
              result.error.issues.some(
                (i) => i.path.includes("address") || i.path.includes("addresses"),
              )
                ? `住所を 1〜${BATCH_MAX} 件渡してください (POST は addresses の配列、GET は address の繰り返し)`
                : result.error.issues.some((i) => i.path.includes("address"))
                  ? "address を 1〜100 文字で渡してください"
                  : result.error.issues.some((i) => i.path.includes("limit"))
                    ? "limit は 1〜10 の整数で渡してください"
                    : result.error.issues.some((i) => i.path.includes("format"))
                      ? "format は json・geojson・csv のどれかで渡してください"
                      : result.error.issues.some(
                            (i) =>
                              i.path.includes("prefecture_code") || i.path.includes("city_code"),
                          )
                        ? "prefecture_code は 2 桁、city_code は 5 桁か 6 桁の数字で渡してください"
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
    matched_address: z.string().openapi({ description: "照合できた住所の表記" }),
    unmatched_address: z
      .array(z.string())
      .nullable()
      .openapi({ description: "照合できずに残った部分 (番号・建物名など)。残りが無ければ null" }),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    match_level: MatchLevel.openapi({
      description:
        "住所をどの階層まで照合できたか。rsdtdsp_rsdt は号、rsdtdsp_blk は街区、parcel は地番、machiaza_detail は小字、machiaza は町字",
    }),
    coordinates_level: CoordinatesLevel.nullable().openapi({
      description:
        "座標を取った代表点の階層。値の意味は match_level と同じ。番号まで照合できてもその代表点に座標が無ければ町字の代表点で埋め、machiaza になる。parcel_parent は地番の親番 (「28番地10」の「28」) の点で、ABR の親番の筆の点、国交省の街区レベル位置参照情報の点、ABR の枝番の筆の点の平均の順に取る (ABR にその地番の点が無いとき)。どれも代表点で、建物の位置ではない",
    }),
    lg_code: z
      .string()
      .nullable()
      .openapi({ description: "全国地方公共団体コード (6 桁、検査数字つき)" }),
    ambiguous: z.boolean().openapi({
      description:
        "住所から 1 つに決められない候補が複数あり、そのうち 1 つを選んだか。市区町村名の無い住所で同じ町名を持つ市区町村が複数あるときと、地番に甲乙丙丁が書かれておらず、甲乙丙丁の違いだけの地番が複数あるときに true になる。市区町村は prefecture_code・city_code で絞れる",
    }),
    candidates: z.number().int().openapi({
      description:
        "照合できた候補の数 (ふつうは 1)。市区町村の候補は人口の多い順、地番の候補は代表点の優先順位の順に並ぶ。limit を増やすと全部を受け取れる",
    }),
    score: optional(
      z.number().openapi({ description: "候補の並び順に使う一致の度合い。1 は完全一致" }),
      "match",
    ),
    structured_address: optional(StructuredAddress, "structured_address"),
    ids: optional(Ids, "ids"),
    codes: optional(ForwardCodes, "codes"),
    estat_small_area_code: smallArea.optional(),
  })
  .openapi("GeocodeResult");

/** 1 つの住所の答え。単発も一括もこの形 */
const ForwardItem = z
  .object({
    address: z.string().openapi({ description: "渡した住所" }),
    results: z.array(GeocodeResult).openapi({
      description:
        "一致の度合いの高い順。照合できない住所と、空や長すぎる住所 (一括のとき) は空の配列",
    }),
  })
  .openapi("ForwardItem");

const GeocodeResponse = ForwardItem.extend({ source: Source }).openapi("GeocodeResponse");

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
          ambiguous: z.boolean(),
          candidates: z.number().int(),
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

// 1 件ごとに市区町村の町字を読むので、市区町村がばらばらだと 100 件で CPU の上限 (30 秒) を超えた。町字の表の行グループを小さくするまでは 25 件にする
const BATCH_MAX = 25;

/** /v1/forward の include の項目の組と中身 */
const INCLUDE_DOCS: Record<(typeof INCLUDES)[number], string> = {
  match: "候補の並び順に使う一致の度合い (score)",
  structured_address: "都道府県・市区町村・町字・番号に区切った住所 (structured_address)",
  ids: "アドレス・ベース・レジストリの町字 ID などの ID (ids)",
  codes: "都道府県コード・市区町村コード・郵便番号・地域メッシュ (codes)",
  small_area: "座標が入る国勢調査の小地域コード (estat_small_area_code)",
};

const prefectureCodeParam = z
  .string()
  .regex(/^\d{2}$/)
  .optional()
  .openapi({
    param: {
      name: "prefecture_code",
      in: "query",
      description: "都道府県コード (2 桁)。渡すと、その都道府県の結果だけを返す",
    },
    example: "25",
  });
const cityCodeParam = z
  .string()
  .regex(/^\d{5,6}$/)
  .optional()
  .openapi({
    param: {
      name: "city_code",
      in: "query",
      description:
        "全国地方公共団体コード (5 桁か 6 桁)。渡すと、その市区町村の結果だけを返す。prefecture_code より優先する",
    },
    example: "25207",
  });

/** 結果を絞る地域。市区町村コードの頭 5 桁か都道府県コード */
const areaOf = (prefecture_code?: string, city_code?: string) =>
  city_code?.slice(0, 5) ?? prefecture_code;

const limitParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(10))
  .optional()
  .openapi({
    param: { name: "limit", in: "query", description: "返す候補の数の上限 (1〜10、既定 1)" },
    type: "integer",
    example: 1,
  } as never);

const forwardRoute = createRoute({
  method: "get",
  path: "/v1/forward",
  summary: "住所を座標と地域コードに変換する",
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
      limit: limitParam,
      prefecture_code: prefectureCodeParam,
      city_code: cityCodeParam,
      include: includeParam(INCLUDE_DOCS),
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
      description: "照合の結果。照合できなければ results (features) が空",
    },
    400: {
      content: { "application/json": { schema: ErrorBody } },
      description: "住所が空か 100 文字を超える、またはパラメータが不正",
    },
    429: {
      content: { "application/json": { schema: ErrorBody } },
      description: "リクエストの回数が上限 (1 分に 300 回) を超えた",
    },
    502: {
      content: { "application/json": { schema: ErrorBody } },
      description: "住所のデータを読み込めない",
    },
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
const answer = async (
  env: Env,
  address: string,
  limit: number,
  groups: ReadonlySet<Include>,
  area?: string,
) => {
  const { results, postalCode } = await geocode(env, address, limit, area);
  const extras = await Promise.all(
    results.map(async (r): Promise<Extras> => ({
      postal_code: groups.has("codes") ? await postalCode(r) : null,
      estat_small_area_code: groups.has("small_area") ? await smallAreaOf(env, r) : null,
    })),
  );
  return results.map((r, i) => [r, extras[i]] as const);
};

/** 照合の記録を応答の後に送る。記録先が無ければ何もしない。送れなくても応答には響かせない */
const record = (c: Context<{ Bindings: Env }>, entries: RequestLogEntry[]) => {
  if (!c.env.REQUEST_LOG_URL) return;
  c.executionCtx.waitUntil(
    sendLog(c.env, entries).catch((e: unknown) => console.error("geocoder: log", e)),
  );
};

/** 位置参照情報の点で座標を埋めた答え */
const usesIsj = (r: MatchedResult) => r.coordinate_source === "isj";

/** isj は位置参照情報の点を使った答えがあるか。あればその出典も足す */
const attributionFor = (groups: ReadonlySet<Include>, isj: boolean, former = false) => [
  ABR_ATTRIBUTION,
  ...(isj ? [ISJ_ATTRIBUTION] : []),
  ...(former ? [FORMER_CITY_ATTRIBUTION] : []),
  ...(groups.has("small_area") ? [SMALL_AREA_ATTRIBUTION] : []),
];

/** 単発と一括で共通の引数 */
type ForwardOptions = {
  limit?: number;
  include?: string;
  prefecture_code?: string;
  city_code?: string;
};

type Answered = Awaited<ReturnType<typeof answer>>;

/**
 * 1 つの住所を照合する。単発も一括もこれを通す。空や長すぎる住所は null。
 * 表を読めないときは投げる
 */
const forwardOne = async (
  env: Env,
  address: string,
  limit: number,
  groups: ReadonlySet<Include>,
  area: string | undefined,
): Promise<Answered | null> => {
  const r = await tryCatchAsync(() => answer(env, address, limit, groups, area));
  if (r.ok) return r.value;
  if (r.error instanceof ErrEmptyAddress || r.error instanceof ErrAddressTooLong) return null;
  throw r.error;
};

/** 照合した住所たちを応答の形にし、記録も送る。単発は 1 件、一括は住所の数だけ */
const forwardItems = async (
  c: Context<{ Bindings: Env }>,
  endpoint: string,
  addresses: readonly string[],
  options: ForwardOptions,
) => {
  const groups = parseInclude(options.include);
  if (groups === null) return { error: `include に使えるのは ${INCLUDES.join(",")} です` } as const;
  const area = areaOf(options.prefecture_code, options.city_code);
  const limit = options.limit ?? 1;
  // 1 件ずつ照合する。同じ市区町村の住所が続けば、読んだ表を使い回せる
  const answered = await tryCatchAsync(async () => {
    const out: (Answered | null)[] = [];
    for (const a of addresses) out.push(await forwardOne(c.env, a, limit, groups, area));
    return { pairs: out, version: await dataVersion(c.env) };
  });
  if (!answered.ok) return { failed: answered.error } as const;
  const { pairs, version } = answered.value;
  record(
    c,
    addresses.flatMap((a, i) =>
      pairs[i] === null
        ? []
        : [
            logEntry(
              endpoint,
              a,
              (pairs[i] ?? []).map(([r]) => r),
            ),
          ],
    ),
  );
  const flat = pairs.flatMap((p) => p ?? []);
  return {
    groups,
    limit,
    pairs,
    items: addresses.map((address, i) => ({
      address,
      results: (pairs[i] ?? []).map(([r, x]) => forwardAnswer(r, groups, x)),
    })),
    source: {
      version,
      attribution: attributionFor(
        groups,
        flat.some(([r]) => usesIsj(r)),
        flat.some(([r]) => r.former_city === true),
      ),
    },
  } as const;
};

app.openapi(forwardRoute, async (c) => {
  const { address, format, ...options } = c.req.valid("query");
  const out = await forwardItems(c, "forward", [address], options);
  if ("error" in out) return json(c, 400, { error: out.error }, "no-store") as never;
  if ("failed" in out) {
    console.error("geocoder: forward", out.failed);
    return json(c, 502, { error: "住所の表を読めませんでした" }, "no-store") as never;
  }
  const [answered] = out.pairs;
  if (answered === null)
    return json(c, 400, { error: "address を 1〜100 文字で渡してください" }, "no-store") as never;
  const { groups, limit, items, source } = out;
  const [{ results }] = items;
  const { version, attribution } = source;
  const headers = { "Cache-Control": "public, max-age=86400" };
  if (format === "geojson") {
    const body = {
      type: "FeatureCollection",
      query: { address, limit },
      result_info: {
        count: answered.length,
        limit,
        api_version: API_VERSION,
        db_version: version,
      },
      features: answered.map(([r, x]) => forwardFeature(r, groups, x)),
      attribution,
    };
    return c.body(JSON.stringify(body), 200, {
      ...headers,
      "Content-Type": "application/geo+json",
    }) as never;
  }
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
  return c.json({ address, results, source }, 200, headers) as never;
});

app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Queria Geocoder",
    version: API_VERSION,
    description: [
      "日本の住所と座標・地域コードを相互に変換する無料の API。API キーは不要。",
      [
        "- `GET /v1/forward`: 住所 1 件を座標と地域コードに変換する",
        `- \`POST /v1/forward/batch\`: 住所を ${BATCH_MAX} 件までまとめて変換する。結果は住所ごとに \`/v1/forward\` と同じ形`,
        "- `GET /v1/forward/batch`: POST と同じ一括変換を、住所をクエリに入れて呼ぶ。DuckDB の `read_json` のように URL しか読めないツール向け",
        "- `GET /v1/reverse`: 座標から市区町村・国勢調査の小地域のコードを取得する",
      ].join("\n"),
      "結果に含める項目は `include` で選ぶ（例: `include=ids,codes,small_area`）。既定は座標と照合の結果だけ。",
      "1 つの IP アドレスから 1 分に 300 回まで（一括は 1 回の呼び出しで 1 回と数える）。結果を公開するときは `source.attribution` の出典も表示する。",
      "概要と精度は [queria.io/geocoder](https://queria.io/geocoder)、ソースコードとセルフホストの手順は [GitHub](https://github.com/queria-io/geocoder) を参照。",
    ].join("\n\n"),
  },
});

const BATCH_RESPONSES = {
  200: {
    content: {
      "application/json": {
        schema: z
          .object({
            results: z.array(ForwardItem).openapi({
              description: "渡した住所と同じ順・同じ数。中身は /v1/forward と同じ",
            }),
            source: Source,
          })
          .openapi("BatchResponse"),
      },
    },
    description: "住所ごとに、/v1/forward と同じ results を返す。limit も同じく効く",
  },
  400: { content: { "application/json": { schema: ErrorBody } }, description: "パラメータが不正" },
  429: {
    content: { "application/json": { schema: ErrorBody } },
    description: "リクエストの回数が上限 (1 分に 300 回) を超えた",
  },
  502: {
    content: { "application/json": { schema: ErrorBody } },
    description: "住所のデータを読み込めない",
  },
};

const batchRoute = createRoute({
  method: "post",
  path: "/v1/forward/batch",
  summary: "住所をまとめて変換する",
  description: `住所を 1 回に ${BATCH_MAX} 件まで JSON の addresses で渡す。結果は渡した住所と同じ順・同じ数で返す。回数の上限は 1 回の呼び出しで 1 回と数える`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              addresses: z.array(z.string()).min(1).max(BATCH_MAX),
              limit: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .openapi({ description: "/v1/forward と同じ。住所ごとに効く" }),
              include: z.string().optional().openapi({ description: "/v1/forward と同じ" }),
              prefecture_code: z
                .string()
                .regex(/^\d{2}$/)
                .optional()
                .openapi({ description: "/v1/forward と同じ。全部の住所に効く" }),
              city_code: z
                .string()
                .regex(/^\d{5,6}$/)
                .optional()
                .openapi({ description: "/v1/forward と同じ。全部の住所に効く" }),
            })
            .openapi("BatchRequest"),
        },
      },
    },
  },
  responses: BATCH_RESPONSES,
});

/** GET の一括。住所を address で繰り返して渡す (DuckDB の read_json や表計算から呼べる) */
const batchGetRoute = createRoute({
  method: "get",
  path: "/v1/forward/batch",
  summary: "住所をまとめて変換する (GET)",
  description: `POST と同じ一括変換を、住所をクエリに入れて呼ぶ。DuckDB の read_json のように URL しか読めないツール向けで、それ以外は POST を使う。住所は address=…&address=… と繰り返して ${BATCH_MAX} 件まで渡す。URL が長くなりすぎないよう、1 回に 10 件ほどにする。レスポンスは POST と同じ`,
  request: {
    query: z.object({
      address: z
        .preprocess(
          (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]),
          z.array(z.string()).min(1).max(BATCH_MAX),
        )
        .openapi({
          param: { name: "address", in: "query", style: "form", explode: true },
          type: "array",
          items: { type: "string" },
        } as never),
      limit: limitParam,
      include: includeParam(INCLUDE_DOCS),
      prefecture_code: prefectureCodeParam,
      city_code: cityCodeParam,
    }),
  },
  responses: BATCH_RESPONSES,
});

/** 住所をまとめて照合する。GET と POST で同じ。1 件ごとの処理は /v1/forward と同じ forwardItems */
const batch = async (
  c: Context<{ Bindings: Env }>,
  addresses: string[],
  options: ForwardOptions,
) => {
  const out = await forwardItems(c, "forward/batch", addresses, options);
  if ("error" in out) return json(c, 400, { error: out.error }, "no-store") as never;
  if ("failed" in out) {
    console.error("geocoder: batch", out.failed);
    return json(c, 502, { error: "住所の表を読めませんでした" }, "no-store") as never;
  }
  return c.json({ results: out.items, source: out.source }, 200, {
    "Cache-Control": "no-store",
  }) as never;
};

app.openapi(batchRoute, async (c) => {
  const { addresses, ...options } = c.req.valid("json");
  return (await batch(c, addresses, options)) as never;
});
app.openapi(batchGetRoute, async (c) => {
  const { address, ...options } = c.req.valid("query");
  return (await batch(c, address, options)) as never;
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
  if (groups.has("address")) {
    const version = await tryCatchAsync(() => dataVersion(c.env));
    if (!version.ok) {
      console.error("geocoder: reverse", version.error);
      return c.json({ error: "住所の表を読めませんでした" }, 502, { "Cache-Control": "no-store" });
    }
    cacheUrl.searchParams.set("data", version.value);
  }
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

// ここは API と仕様書だけ。/ は仕様書を見せる
app.get("/", (c) => c.redirect("/docs", 302));
app.get("/docs", (c) => c.html(DOCS_HTML, 200, { "Cache-Control": "public, max-age=3600" }));

app.all("/v1/reverse", (c) => c.body("Method Not Allowed", 405, { Allow: "GET" }));
app.all("/v1/forward", (c) => c.body("Method Not Allowed", 405, { Allow: "GET" }));
app.all("/v1/forward/batch", (c) => c.body("Method Not Allowed", 405, { Allow: "GET, POST" }));
app.notFound((c) => json(c, 404, { error: "not found" }, "no-store"));

export default app satisfies ExportedHandler<Env>;
