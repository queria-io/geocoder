// 町字を市区町村ごとに読み込む Repository。Worker は全国の町字 (約 73 万行) を持てないので、
// 問い合わせの住所から市区町村を絞り、その市区町村の行だけを読む。絞った後の検索は memory.ts と同じ
import { All } from "../model/model";
import { MaxEditDistance } from "../util/address";
import { byteLength, editdist3, utf8 } from "./editdist";
import { memoryRepository, type CityRow, type PrefRow } from "./memory";
import type { BasicResult, Repository } from "./types";

/** 都道府県で絞ったあいまい一致で読む市区町村の数。上流は都道府県の町字を全部見るが、ここでは名前の近い順に絞る */
const maxFuzzyCities = 20;

export const lazyRepository = (
  loadCity: (lgCode: string) => Promise<BasicResult[]>,
  cities: CityRow[],
  prefs: PrefRow[],
): Repository => {
  const empty = memoryRepository([], cities, prefs);
  const inPref = (p: string) =>
    p === "" || p === All ? cities : cities.filter((c) => c.prefCode === p);
  /** 住所の頭に名前がそのまま入っている市区町村 */
  const citiesPrefixOf = (address: string, prefCode: string) =>
    inPref(prefCode).filter((c) => address.startsWith(c.normalizedAddress));
  /** 市区町村の部分の名前が近い順 */
  const nearestCities = (address: string, prefCode: string) => {
    const a = utf8(address);
    return inPref(prefCode)
      .map((c) => ({
        c,
        d: editdist3(a.slice(0, utf8(c.normalizedAddress).length), utf8(c.normalizedAddress)),
      }))
      .filter(({ c, d }) => d <= MaxEditDistance(byteLength(c.normalizedAddress)))
      .sort((x, y) => x.d - y.d)
      .slice(0, maxFuzzyCities)
      .map(({ c }) => c);
  };
  // 政令市の市のコードには町字が無い (町字は区のコードで持つ)。読みに行くと、そのコードの前後の
  // 行グループをまとめて読むことになるので外す
  const hasWards = new Set(cities.filter((c) => c.ward).map((c) => `${c.pref}\t${c.city}`));
  const designated = new Set(
    cities.filter((c) => !c.ward && hasWards.has(`${c.pref}\t${c.city}`)).map((c) => c.lgCode),
  );
  const over = async (lgCodes: string[]) =>
    memoryRepository(
      (
        await Promise.all([...new Set(lgCodes)].filter((c) => !designated.has(c)).map(loadCity))
      ).flat(),
      cities,
      prefs,
    );
  const codes = (cs: CityRow[]) => cs.map((c) => c.lgCode);

  return {
    ...empty,
    FindBasicByAddress: async (p) =>
      (await over(codes(citiesPrefixOf(p.address, p.prefCode)))).FindBasicByAddress(p),
    FindBasicByPrefix: async (p) =>
      (await over(codes(citiesPrefixOf(p.baseAddr, p.prefCode)))).FindBasicByPrefix(p),
    FindBasicByLevenshtein: async (p) => {
      const scope =
        p.lgCode !== ""
          ? [p.lgCode]
          : p.prefCode !== "" && p.prefCode !== All
            ? codes(nearestCities(p.searchAddr, p.prefCode))
            : p.lgCodes;
      return (await over(scope)).FindBasicByLevenshtein(p);
    },
  };
};
