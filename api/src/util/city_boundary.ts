// abrg/internal/util/city_boundary.go の写し (upstream/UPSTREAM のコミット)

const isCityMarker = (ch: string): boolean =>
  ch === "区" || ch === "市" || ch === "町" || ch === "村";

/** 区・市・町・村の印で市区町村の終わりを推す。辞書に無い住所のため */
export const findCityBoundary = (addr: string): number => {
  const runes = Array.from(addr);
  let pos = 0;
  for (let i = 0; i < runes.length; i++) {
    const ch = runes[i];
    if (!isCityMarker(ch)) {
      pos += ch.length;
      continue;
    }
    let end = pos + ch.length;
    if (ch === "区") return end;
    // 印が続くとき (田村市) は後ろの印が市区町村の終わり
    const next = runes[i + 1];
    if (next !== undefined && isCityMarker(next)) {
      end += next.length;
      if (next === "区") return end;
    }
    // 市・町・村の後に区があれば政令市の区まで (大阪市天王寺区)
    const ward = addr.indexOf("区", end);
    return ward >= 0 ? ward + 1 : end;
  }
  return -1;
};

export type CityBoundary = { find: (addr: string) => number };

/**
 * 市区町村名の辞書でいちばん長く一致する頭を探す。無ければ印で推す。
 * 辞書は TextForDB を通した名前 (市川市・大阪市天王寺区・遠田郡涌谷町)
 */
export const NewCityBoundary = (cityStrings: string[]): CityBoundary => {
  const set = new Set(cityStrings.filter((s) => s !== ""));
  const maxLen = Math.max(0, ...Array.from(set, (s) => s.length));
  return {
    find: (addr) => {
      for (let end = Math.min(addr.length, maxLen); end > 0; end--) {
        if (set.has(addr.slice(0, end))) return end;
      }
      return findCityBoundary(addr);
    },
  };
};
