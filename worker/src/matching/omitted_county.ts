// 上流 (abr-geocoder) には無い、こちらだけの直し。町字の表の名前は「郡+町村+町字」でつないであり、
// 照合は完全一致なので、郡を省いた住所 (北海道当別町春日町…) は町字が 1 つも当たらなかった。
// 都道府県が分かっているとき、検索文字が郡のある町村の名前で始まっていれば、頭に郡を足す
import type { CityRow } from "../repository/memory";

type Name = { city: string; county: string };

/** 都道府県コード → その都道府県の町村名 (長い順)。郡が 2 つ以上に割れる名前は郡を空にする */
export type CountyIndex = Map<string, Name[]>;

export const buildCountyIndex = (cities: CityRow[]): CountyIndex =>
  new Map(
    [...Map.groupBy(cities, (c) => c.prefCode)].map(([pref, rows]) => [
      pref,
      [...Map.groupBy(rows, (c) => c.city)]
        .map(([city, rs]): Name => {
          const counties = new Set(rs.map((r) => r.county ?? ""));
          return { city, county: counties.size === 1 ? [...counties][0] : "" };
        })
        .sort((a, b) => b.city.length - a.city.length),
    ]),
  );

/** 郡を省いた町村の名前で始まる検索文字に、郡を足す。当てはまらなければそのまま返す */
export const restoreCounty = (index: CountyIndex, searchAddr: string, pref: string): string => {
  const hit = (index.get(pref) ?? []).find((n) => searchAddr.startsWith(n.city));
  return hit && hit.county !== "" ? hit.county + searchAddr : searchAddr;
};
