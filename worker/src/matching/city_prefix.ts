// abrg/internal/matching/city_prefix.go の写し (upstream/UPSTREAM のコミット)

/** 都道府県を書かない住所の、市区町村名から都道府県コードを引く表。頭の 2 文字で分けておく */
export type CityPrefixMap = Map<string, { city: string; code: string }[]>;

const firstTwoRunes = (s: string): string => {
  const runes = Array.from(s);
  return runes.length < 2 ? "" : runes[0] + runes[1];
};

export const buildCityPrefixMap = (cityPrefCodes: Map<string, string>): CityPrefixMap =>
  Map.groupBy(
    [...cityPrefCodes]
      .map(([city, code]) => ({ city, code }))
      .filter(({ city }) => firstTwoRunes(city) !== ""),
    ({ city }) => firstTwoRunes(city),
  );

export const lookupCityPrefix = (m: CityPrefixMap, address: string): string => {
  const key = firstTwoRunes(address);
  if (key === "") return "";
  return m.get(key)?.find((e) => address.startsWith(e.city))?.code ?? "";
};
