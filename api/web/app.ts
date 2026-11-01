// geocoder.queria.io のページ。試す欄・地図・一括変換。API は同じオリジンの /v1 を呼ぶ
import { layers, namedFlavor } from "@protomaps/basemaps";
import * as maplibregl from "maplibre-gl";

import { chunks, guessAddressColumn, parseCsv, toCsv } from "./csv";

const ASSETS = "https://assets.queria.io/basemap";
const BASEMAP = "japan-20260901-z14";
const MAX_ROWS = 1000;
const BATCH = 100;

const LEVEL: Record<string, string> = {
  pref: "都道府県",
  city: "市区町村",
  machiaza: "町字",
  machiaza_detail: "小字",
  rsdtdsp_blk: "街区（○番）",
  rsdtdsp_rsdt: "住居（○番○号）",
  parcel: "地番",
  prefecture: "都道府県",
  small_area: "小地域",
};
const levelText = (v: string | null) => (v === null ? "なし" : (LEVEL[v] ?? v));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const map = new maplibregl.Map({
  container: "map",
  center: [139.7671, 35.6812],
  zoom: 12,
  localIdeographFontFamily: "sans-serif",
  style: {
    version: 8,
    glyphs: `${ASSETS}/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/assets/sprites/${dark ? "dark" : "light"}`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [`${ASSETS}/tiles/${BASEMAP}/{z}/{x}/{y}.mvt`],
        maxzoom: 14,
        attribution:
          '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
      },
    },
    layers: layers("protomaps", namedFlavor(dark ? "dark" : "light"), { lang: "ja" }),
  },
});
const marker = new maplibregl.Marker({ color: "#7c3aed" });

/** 項目名と値の並びを dl にする。値は textContent で入れる */
const list = (pairs: [string, string | number | null | undefined][]) => {
  const dl = document.createElement("dl");
  for (const [k, v] of pairs) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = k;
    dd.textContent = v === null || v === undefined || v === "" ? "—" : String(v);
    dl.append(dt, dd);
  }
  return dl;
};

const show = (title: string, body: Node) => {
  const box = $("try-result");
  const h = document.createElement("h3");
  h.textContent = title;
  box.replaceChildren(h, body);
};

const getJson = async (path: string, params: Record<string, string>) => {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

const tryAddress = async (address: string) => {
  show("調べています…", document.createTextNode(""));
  const body = await getJson("/v1/geocode", { address, include: "codes,small_area" }).catch(
    (e: Error) => ({ error: e.message }),
  );
  if ("error" in body) return show("調べられませんでした", document.createTextNode(body.error));
  const r = body.results[0];
  if (!r) return show("当たりませんでした", document.createTextNode("住所を見直してください。"));
  if (r.lat !== null) {
    marker.setLngLat([r.lng, r.lat]).addTo(map);
    map.flyTo({ center: [r.lng, r.lat], zoom: r.coordinates_level === "rsdtdsp_rsdt" ? 17 : 15 });
  }
  show(
    r.matched_address,
    list([
      ["残り", r.unmatched_address?.join("")],
      ["当たった段", levelText(r.match_level)],
      ["座標の点", levelText(r.coordinates_level)],
      ["緯度, 経度", r.lat === null ? null : `${r.lat}, ${r.lng}`],
      ["市区町村コード", r.lg_code],
      ["小地域コード", r.estat_small_area_code],
      ["郵便番号", r.codes.postal_code],
      ["1km メッシュ", r.codes.mesh_1km],
    ]),
  );
};

$("try-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const address = $<HTMLInputElement>("try-address").value.trim();
  if (address !== "") void tryAddress(address);
});

map.on("click", async (e) => {
  const { lat, lng } = e.lngLat;
  marker.setLngLat([lng, lat]).addTo(map);
  const body = await getJson("/v1/reverse", {
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    include: "codes",
  }).catch((err: Error) => ({ error: err.message }));
  if ("error" in body) return show("調べられませんでした", document.createTextNode(body.error));
  show(
    `${body.lat}, ${body.lng}`,
    list([
      ["入った区画", levelText(body.match_level)],
      ["市区町村コード", body.lg_code],
      ["小地域コード", body.estat_small_area_code],
      ["1km メッシュ", body.codes.mesh_1km],
    ]),
  );
});

// 一括変換
let table: string[][] = [];

$<HTMLInputElement>("batch-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  const status = $("batch-status");
  $("batch-download").hidden = true;
  if (!file) return;
  table = parseCsv(await file.text());
  const [header = [], ...rows] = table;
  const select = $<HTMLSelectElement>("batch-column");
  select.replaceChildren(
    ...header.map((h, i) => new Option(h === "" ? `${i + 1} 列目` : h, String(i))),
  );
  select.value = String(guessAddressColumn(header));
  select.disabled = header.length === 0;
  const tooMany = rows.length > MAX_ROWS;
  $<HTMLButtonElement>("batch-run").disabled = rows.length === 0 || tooMany;
  status.textContent = tooMany
    ? `${rows.length.toLocaleString()} 行あります。1 回に変換できるのは ${MAX_ROWS.toLocaleString()} 行までです。`
    : `${rows.length.toLocaleString()} 行を読みました。`;
});

const COLUMNS = [
  "matched_address",
  "lat",
  "lng",
  "match_level",
  "coordinates_level",
  "lg_code",
  "postal_code",
  "mesh_1km",
] as const;

type Row = Record<(typeof COLUMNS)[number], string | number | null>;

const flat = (r: Record<string, any> | null): Row =>
  Object.fromEntries(
    COLUMNS.map((c) => [c, r === null ? null : (r[c] ?? r.codes?.[c] ?? null)]),
  ) as Row;

const postBatch = async (addresses: string[]) => {
  const res = await fetch("/v1/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addresses, include: "codes" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body as { results: (Record<string, any> | null)[]; source: { attribution: string[] } };
};

const output = (
  format: string,
  header: string[],
  rows: string[][],
  found: Row[],
  attribution: string[],
) => {
  if (format === "csv")
    return {
      type: "text/csv",
      ext: "csv",
      text: toCsv([
        [...header, ...COLUMNS],
        ...rows.map((r, i) => [...r, ...COLUMNS.map((c) => found[i][c])]),
      ]),
    };
  const record = (r: string[]) =>
    Object.fromEntries(header.map((h, i) => [h || `${i + 1}`, r[i] ?? ""]));
  if (format === "json")
    return {
      type: "application/json",
      ext: "json",
      text: JSON.stringify(
        { rows: rows.map((r, i) => ({ ...record(r), ...found[i] })), attribution },
        null,
        1,
      ),
    };
  return {
    type: "application/geo+json",
    ext: "geojson",
    text: JSON.stringify({
      type: "FeatureCollection",
      features: rows.map((r, i) => ({
        type: "Feature",
        geometry:
          found[i].lat === null
            ? null
            : { type: "Point", coordinates: [found[i].lng, found[i].lat] },
        properties: { ...record(r), ...found[i] },
      })),
      attribution,
    }),
  };
};

$("batch-run").addEventListener("click", async () => {
  const [header = [], ...rows] = table;
  const col = Number($<HTMLSelectElement>("batch-column").value);
  const status = $("batch-status");
  const run = $<HTMLButtonElement>("batch-run");
  run.disabled = true;
  const found: Row[] = [];
  let attribution: string[] = [];
  for (const part of chunks(rows, BATCH)) {
    status.textContent = `${found.length.toLocaleString()} / ${rows.length.toLocaleString()} 行を変換しました…`;
    const res = await postBatch(part.map((r) => (r[col] ?? "").slice(0, 100))).catch(
      (e: Error) => e,
    );
    if (res instanceof Error) {
      status.textContent = `途中で止まりました（${res.message}）。少し待ってからもう一度押してください。`;
      run.disabled = false;
      return;
    }
    attribution = res.source.attribution;
    found.push(...res.results.map(flat));
  }
  const hits = found.filter((f) => f.lat !== null).length;
  status.textContent = `${rows.length.toLocaleString()} 行のうち ${hits.toLocaleString()} 行に座標が付きました。結果を載せるときは出典（${attribution.join("、")}）も載せてください。`;
  const out = output($<HTMLSelectElement>("batch-format").value, header, rows, found, attribution);
  const link = $<HTMLAnchorElement>("batch-download");
  link.href = URL.createObjectURL(new Blob([out.text], { type: out.type }));
  link.download = `geocoded.${out.ext}`;
  link.hidden = false;
  run.disabled = false;
});
