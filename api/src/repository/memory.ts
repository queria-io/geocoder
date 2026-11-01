// 町字・市区町村・都道府県の行をメモリに持つ Repository。上流の SQL (abrg/internal/repository) と同じ絞り込みと並びで返す
import { All, MaxChomeNumber } from "../model/model";
import { ExtractChomeDigits, MaxEditDistance } from "../util/address";
import { byteLength, editdist3, utf8 } from "./editdist";
import { findParcelExact, type ParcelRow } from "./parcel";
import { findResidentialBestMatch, machiazaKey, type RsdtdspRow } from "./rsdtdsp";
import type { BasicResult, CityResult, PrefectureResult, Repository } from "./types";

export type CityRow = CityResult & { prefCode: string; normalizedAddress: string };
export type PrefRow = PrefectureResult & { prefCode: string };

const prefCodeOf = (lgCode: string): string => lgCode.slice(0, 2);
const anyPref = (p: string): boolean => p === "" || p === All;

/** 文字列を DuckDB と同じくバイト順で比べる (サロゲートを含む文字で UTF-16 の順と食い違わないように) */
const byteCompare = (a: string, b: string): number => {
  const [x, y] = [utf8(a), utf8(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
};
const cmp = (a: string | null, b: string | null): number =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : byteCompare(a, b);
const thenBy =
  <T>(...fs: ((a: T, b: T) => number)[]) =>
  (a: T, b: T): number =>
    fs.reduce((r, f) => (r !== 0 ? r : f(a, b)), 0);

/** 検索文字の "1@:" の丁目を町字 ID の 5〜7 桁 ("001") にする。上流の extractChomeFilter */
const chomeFilter = (searchAddr: string): string | null => {
  const idx = searchAddr.indexOf("@:");
  if (idx <= 0) return null;
  const digits = ExtractChomeDigits(searchAddr.slice(0, idx));
  const n = Number(digits);
  if (digits === "" || !(n > 0 && n <= MaxChomeNumber)) return null;
  return String(n).padStart(3, "0");
};

export const memoryRepository = (
  towns: BasicResult[],
  cities: CityRow[],
  prefs: PrefRow[],
  rsdtdsp: RsdtdspRow[] = [],
  parcels: ParcelRow[] = [],
): Repository => {
  const byMachiaza = Map.groupBy(rsdtdsp, (r) => machiazaKey(r.lg_code, r.machiaza_id));
  const parcelsByMachiaza = Map.groupBy(parcels, (r) => machiazaKey(r.lg_code, r.machiaza_id));
  const byAddress = Map.groupBy(towns, (t) => t.normalizedAddress);
  const byPref = Map.groupBy(towns, (t) => prefCodeOf(t.lgCode));
  const byLgCode = Map.groupBy(towns, (t) => t.lgCode);
  const bytes = new Map<string, Uint8Array>();
  const bytesOf = (s: string) => bytes.get(s) ?? (bytes.set(s, utf8(s)), utf8(s));
  const inPref = <T extends { prefCode: string }>(rows: T[], p: string) =>
    anyPref(p) ? rows : rows.filter((r) => r.prefCode === p);
  const townsInPref = (p: string) => (anyPref(p) ? towns : (byPref.get(p) ?? []));
  const dist = (a: string, b: string) => editdist3(bytesOf(a), bytesOf(b));
  const city = (c: CityRow): CityResult => ({
    lgCode: c.lgCode,
    pref: c.pref,
    county: c.county,
    city: c.city,
    ward: c.ward,
    lon: c.lon,
    lat: c.lat,
  });

  return {
    FindCityRecord: async ({ cityPart, prefCode }) => {
      const hit = inPref(cities, prefCode)
        .filter((c) => cityPart.startsWith(c.normalizedAddress))
        .sort((a, b) => b.normalizedAddress.length - a.normalizedAddress.length)[0];
      return hit ? city(hit) : null;
    },
    FindCityRecordFuzzy: async ({ cityPart, prefCode, maxEditDistance }) => {
      if (anyPref(prefCode)) return null;
      const hit = inPref(cities, prefCode)
        .map((c) => ({ c, d: dist(cityPart, c.normalizedAddress) }))
        .filter(({ d }) => d <= maxEditDistance)
        .sort((a, b) => a.d - b.d)[0];
      return hit ? city(hit.c) : null;
    },
    FindCandidateLgCodes: async ({ cityPart, prefCode, maxEditDistance }) =>
      inPref(cities, prefCode)
        .map((c) => ({ c, d: dist(cityPart, c.normalizedAddress) }))
        .filter(({ d }) => d <= maxEditDistance)
        .sort(
          thenBy(
            (a, b) => a.d - b.d,
            (a, b) => cmp(a.c.lgCode, b.c.lgCode),
          ),
        )
        .slice(0, 20)
        .map(({ c }) => c.lgCode),
    FindPrefecture: async (prefCode) => {
      const p = prefs.find((r) => r.prefCode === prefCode);
      return p ? { lgCode: p.lgCode, prefName: p.prefName } : null;
    },
    FindBasicByAddress: async ({ address, prefCode, limit }) =>
      (byAddress.get(address) ?? [])
        .filter((t) => anyPref(prefCode) || prefCodeOf(t.lgCode) === prefCode)
        .sort(
          thenBy<BasicResult>(
            (a, b) => b.parcelCount + b.rsdtdspCount - (a.parcelCount + a.rsdtdspCount),
            (a, b) => cmp(b.machiazaId, a.machiazaId),
            (a, b) => cmp(a.lgCode, b.lgCode),
            (a, b) => cmp(a.rsdtAddrFlg, b.rsdtAddrFlg),
          ),
        )
        .slice(0, limit),
    FindBasicByLevenshtein: async (p) => {
      const max = MaxEditDistance(byteLength(p.searchAddr));
      const scope = (): BasicResult[] => {
        if (p.machiazaId !== "" && p.lgCode !== "") {
          const inCity = byLgCode.get(p.lgCode) ?? [];
          if (p.machiazaId === "0000000") return inCity;
          const chome = chomeFilter(p.searchAddr);
          return inCity.filter(
            (t) =>
              t.machiazaId.slice(0, 4) === p.machiazaId.slice(0, 4) &&
              (chome === null || t.machiazaId.slice(4, 7) === chome),
          );
        }
        if (p.lgCode !== "") return byLgCode.get(p.lgCode) ?? [];
        if (!anyPref(p.prefCode)) return byPref.get(p.prefCode) ?? [];
        if (p.lgCodes.length > 0) return p.lgCodes.flatMap((c) => byLgCode.get(c) ?? []);
        return towns;
      };
      return scope()
        .map((t) => ({ t, d: dist(p.searchAddr, t.normalizedAddress) }))
        .filter(({ d }) => d <= max)
        .sort(
          thenBy(
            (a, b) => a.d - b.d,
            (a, b) => cmp(a.t.normalizedAddress, b.t.normalizedAddress),
            (a, b) => cmp(a.t.lgCode, b.t.lgCode),
            (a, b) => cmp(a.t.machiazaId, b.t.machiazaId),
            (a, b) => cmp(a.t.rsdtAddrFlg, b.t.rsdtAddrFlg),
          ),
        )
        .slice(0, Math.max(p.limit * 10, 10))
        .map(({ t }) => t);
    },
    FindBasicByPrefix: async ({ baseAddr, prefCode, limit }) =>
      townsInPref(prefCode)
        .filter((t) => baseAddr.startsWith(t.normalizedAddress))
        .sort(
          thenBy<BasicResult>(
            (a, b) =>
              Array.from(b.normalizedAddress).length - Array.from(a.normalizedAddress).length,
            (a, b) => cmp(a.lgCode, b.lgCode),
            (a, b) => cmp(a.machiazaId, b.machiazaId),
            (a, b) => cmp(a.rsdtAddrFlg, b.rsdtAddrFlg),
          ),
        )
        .slice(0, limit),
    FindCityByAddress: async ({ cityAddr, lgCode, prefCode }) => {
      const hit =
        lgCode !== ""
          ? cities.find((c) => c.lgCode === lgCode)
          : inPref(cities, prefCode).find((c) => c.normalizedAddress === cityAddr);
      return hit ? city(hit) : null;
    },
    FindResidentialBestMatch: async (lgCode, machiazaId, filter) =>
      findResidentialBestMatch(byMachiaza.get(machiazaKey(lgCode, machiazaId)) ?? [], filter),
    FindParcelExact: async (lgCode, machiazaId, filter) =>
      findParcelExact(parcelsByMachiaza.get(machiazaKey(lgCode, machiazaId)) ?? [], filter),
  };
};
