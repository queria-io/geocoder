// API の答えの形。当て方 (matching/) は上流の写しのままにして、外向けの形はここで作る。
// 項目名と段の値は abr-geocoder の答え (GeoJSON) にそろえる
import type { CoordinateLevel, MatchedResult } from "./model/model";

/** 全国地方公共団体コードの検査数字。頭 5 桁から 6 桁目を出す */
export const checkDigit = (code5: string): string => {
  const sum = [...code5].reduce((s, d, i) => s + Number(d) * (6 - i), 0);
  return String((11 - (sum % 11)) % 10);
};

export const lgCodeOf = (code5: string | null): string | null =>
  code5 === null ? null : code5 + checkDigit(code5);

/** 標準地域メッシュ (1km・500m・250m) のコード */
export const meshCodes = (lat: number, lng: number) => {
  // 秒にして整数で割る。浮動小数の端数で隣のメッシュに落ちないよう、1/1000 秒に丸める
  const s = Math.round(lat * 3600 * 1000) / 1000;
  const e = Math.round((lng - 100) * 3600 * 1000) / 1000;
  const div = (v: number, size: number) => [Math.floor(v / size), v % size] as const;
  const [p, s1] = div(s, 2400);
  const [q, s2] = div(s1, 300);
  const [r, s3] = div(s2, 30);
  const [h, s4] = div(s3, 15);
  const [k] = div(s4, 7.5);
  const [u, e1] = div(e, 3600);
  const [v, e2] = div(e1, 450);
  const [w, e3] = div(e2, 45);
  const [i, e4] = div(e3, 22.5);
  const [j] = div(e4, 11.25);
  const km1 = `${p}${String(u).padStart(2, "0")}${q}${v}${r}${w}`;
  const m500 = km1 + (h * 2 + i + 1);
  return { mesh_1km: km1, mesh_500m: m500, mesh_250m: m500 + (k * 2 + j + 1) };
};

/** 座標を取った点の段。座標が無ければ null */
export const coordinatesLevel = (r: MatchedResult): CoordinateLevel | null =>
  r.coordinates === null ? null : (r.coordinate_level ?? r.match_level);

export const ABR_ATTRIBUTION =
  "「アドレス・ベース・レジストリ」（デジタル庁）（https://dataset.address-br.digital.go.jp/）を加工して作成";
export const SMALL_AREA_ATTRIBUTION =
  "「国勢調査 境界データ（小地域）」（総務省統計局、e-Stat）を加工して作成";

export const INCLUDES = ["match", "structured_address", "ids", "codes", "small_area"] as const;
export type Include = (typeof INCLUDES)[number];

/** 当てたあとに足す項目。郵便番号は町字の表、小地域は境界タイルから引く */
export type Extras = { postal_code: string | null; estat_small_area_code: string | null };

const codes = (r: MatchedResult, x: Extras) => {
  const lg = r.ids.lg_code;
  return {
    prefecture_code: lg?.slice(0, 2) ?? null,
    city_code: lg !== null && lg.slice(2, 5) !== "000" ? lg.slice(0, 5) : null,
    postal_code: x.postal_code,
    ...(r.coordinates === null
      ? { mesh_1km: null, mesh_500m: null, mesh_250m: null }
      : meshCodes(r.coordinates[1], r.coordinates[0])),
  };
};

/** 市区町村名の無い住所で、同じ町名の市区町村が複数あったか (市区町村を推定したか) とその数 */
const candidatesOf = (r: MatchedResult) => ({
  ambiguous: (r.candidates ?? 1) > 1,
  candidates: r.candidates ?? 1,
});

/** 正引きの 1 件。頼まれた組だけ足す。組の中の項目は値が無くても null で入れる */
export const forwardAnswer = (r: MatchedResult, include: ReadonlySet<Include>, x: Extras) => ({
  matched_address: r.matched_address,
  unmatched_address: r.unmatched_address,
  lat: r.coordinates?.[1] ?? null,
  lng: r.coordinates?.[0] ?? null,
  match_level: r.match_level,
  coordinates_level: coordinatesLevel(r),
  lg_code: r.ids.lg_code,
  ...candidatesOf(r),
  ...(include.has("match") ? { score: r.score } : {}),
  ...(include.has("structured_address") ? { structured_address: r.structured_address } : {}),
  ...(include.has("ids") ? { ids: r.ids } : {}),
  ...(include.has("codes") ? { codes: codes(r, x) } : {}),
  ...(include.has("small_area") ? { estat_small_area_code: x.estat_small_area_code } : {}),
});

/** abr-geocoder と同じ FeatureCollection。abr-geocoder の項目は全部入れ、Queria の項目は頼まれたときだけ */
export const forwardFeature = (r: MatchedResult, include: ReadonlySet<Include>, x: Extras) => ({
  type: "Feature" as const,
  geometry: r.coordinates === null ? null : { type: "Point" as const, coordinates: r.coordinates },
  properties: {
    matched_address: r.matched_address,
    unmatched_address: r.unmatched_address,
    score: r.score,
    match_level: r.match_level,
    coordinates_level: coordinatesLevel(r),
    ids: r.ids,
    structured_address: r.structured_address,
    ...candidatesOf(r),
    ...(include.has("codes") ? { codes: codes(r, x) } : {}),
    ...(include.has("small_area") ? { estat_small_area_code: x.estat_small_area_code } : {}),
  },
});

/** "a,b" を頼まれた組の集まりに。知らない名前は null */
export const parseNames = <T extends string>(
  s: string | undefined,
  allowed: readonly T[],
): Set<T> | null => {
  const names = (s ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  return names.every((n) => (allowed as readonly string[]).includes(n))
    ? new Set(names as T[])
    : null;
};

export const parseInclude = (s: string | undefined): Set<Include> | null => parseNames(s, INCLUDES);

/** 表やタイルのファイル名から拡張子を外した名前。データのバージョンとして返す */
export const versionOf = (file: string): string =>
  file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

const flatten = (o: Record<string, unknown>, prefix = ""): [string, unknown][] =>
  Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [[`${prefix}${k}`, Array.isArray(v) ? v.join("") : v] as [string, unknown]],
  );

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * 答えの行を CSV に。入れ子の項目は structured_address.pref のような列にほどく。
 * 列は 1 行目の項目の順 (どの行も同じ項目を持つ)。Excel で化けないよう BOM を付ける
 */
export const toCsv = (columns: string[], rows: Record<string, unknown>[]): string => {
  const lines = rows.map((r) => {
    const m = new Map(flatten(r));
    return columns.map((c) => cell(m.get(c))).join(",");
  });
  return "﻿" + [columns.join(","), ...lines].join("\r\n") + "\r\n";
};

/** 答えの 1 行の列名。行が無いときも列名だけは返したいので、頼まれた組から作る */
export const csvColumns = (sample: Record<string, unknown>): string[] =>
  flatten(sample).map(([k]) => k);
