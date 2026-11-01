// geocoder.queria.io のページ。住所から場所・地図から住所・ファイルの一括変換の 3 つのタブ。API は同じオリジンの /v1 を呼ぶ
import { layers, namedFlavor } from "@protomaps/basemaps";
import * as maplibregl from "maplibre-gl";

import { chunks, guessAddressColumn, parseCsv, toCsv } from "./csv";

const ASSETS = "https://assets.queria.io/basemap";
const BASEMAP = "japan-20260901-z14";
const MAX_ROWS = 1000;
const BATCH = 100;

/** どこまで分かったかを、段の名前ではなく言葉で */
const LEVEL: Record<string, string> = {
  pref: "都道府県まで",
  city: "市区町村まで",
  machiaza: "町名まで",
  machiaza_detail: "丁目・字まで",
  rsdtdsp_blk: "番まで",
  rsdtdsp_rsdt: "号まで",
  parcel: "地番まで",
};
const levelText = (v: string | null) => (v === null ? "分かりませんでした" : (LEVEL[v] ?? v));

/** 座標をどの点から取ったか */
const POINT: Record<string, string> = {
  machiaza: "町名の代表の点",
  machiaza_detail: "丁目・字の代表の点",
  rsdtdsp_blk: "番の点",
  rsdtdsp_rsdt: "号の点",
  parcel: "地番の点",
};
const pointText = (v: string | null) => (v === null ? "—" : (POINT[v] ?? v));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const map = new maplibregl.Map({
  container: "map",
  center: [139.7372, 35.6794],
  zoom: 15,
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

const el = (tag: string, text: string, className?: string) => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
};

/** 答えの欄: 大きく住所、その下に主な項目、コードはたたんで置く */
const show = (title: string, main: Node[] = [], codes?: HTMLElement) => {
  const box = $("try-result");
  const parts: Node[] = [el("p", title, "answer"), ...main];
  if (codes) {
    const details = document.createElement("details");
    details.append(el("summary", "コードを見る"), codes);
    parts.push(details);
  }
  box.replaceChildren(...parts);
};

const getJson = async (path: string, params: Record<string, string>) => {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
};

const latLng = (lat: number, lng: number) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

const tryAddress = async (address: string, move = true) => {
  show("探しています…");
  const body = await getJson("/v1/geocode", { address, include: "codes,small_area" }).catch(
    (e: Error) => ({ error: e.message }),
  );
  if ("error" in body) return show("探せませんでした", [el("p", body.error)]);
  const r = body.results[0];
  if (!r) return show("見つかりませんでした", [el("p", "住所の書き方を見直してください。")]);
  if (r.lat !== null) {
    marker.setLngLat([r.lng, r.lat]).addTo(map);
    const view = {
      center: [r.lng, r.lat] as [number, number],
      zoom: r.coordinates_level === "rsdtdsp_rsdt" ? 17 : 15,
    };
    if (move) map.flyTo(view);
    else map.jumpTo(view);
  }
  show(
    r.matched_address,
    [
      list([
        ["分かったところ", levelText(r.match_level)],
        ["分からなかった残り", r.unmatched_address?.join("")],
        ["緯度, 経度", r.lat === null ? null : latLng(r.lat, r.lng)],
        ["地図の点", pointText(r.coordinates_level)],
      ]),
    ],
    list([
      ["郵便番号", r.codes.postal_code],
      ["市区町村コード", r.lg_code],
      ["小地域コード", r.estat_small_area_code],
      ["1km メッシュ", r.codes.mesh_1km],
    ]),
  );
};

$("try-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const address = $<HTMLInputElement>("try-address").value.trim();
  if (address !== "") void tryAddress(address);
});

const tryPoint = async (lat: number, lng: number) => {
  marker.setLngLat([lng, lat]).addTo(map);
  show("調べています…");
  const body = await getJson("/v1/reverse", {
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    include: "address,codes",
  }).catch((err: Error) => ({ error: err.message }));
  if ("error" in body) return show("調べられませんでした", [el("p", body.error)]);
  const a = body.address;
  if (!a) return show("日本の住所の外です", [el("p", latLng(lat, lng))]);
  show(
    `${a.matched_address} 付近`,
    [
      list([
        ["押した場所", latLng(lat, lng)],
        ["住所の点まで", `約 ${a.distance_m.toLocaleString()} m`],
        ["分かったところ", levelText(a.match_level)],
      ]),
    ],
    list([
      ["市区町村コード", body.lg_code],
      ["小地域コード", body.estat_small_area_code],
      ["1km メッシュ", body.codes.mesh_1km],
    ]),
  );
};

// タブ。地図を押したら「地図から住所」に切り替える。ファイルのタブでは地図を隠す
const TABS = ["forward", "reverse", "batch"] as const;
type Tab = (typeof TABS)[number];
const select = (tab: Tab) => {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === tab));
    $(`panel-${t}`).hidden = t !== tab;
  }
  $("map-area").hidden = tab === "batch";
  if (tab !== "batch") map.resize();
};
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => select(t));

map.on("click", (e) => {
  select("reverse");
  void tryPoint(e.lngLat.lat, e.lngLat.lng);
});

// 開いたときから例の住所にピンが立っているようにする
void tryAddress($<HTMLInputElement>("try-address").value, false);

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
