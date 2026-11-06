// 住所の残り (市区町村名より後) から点を引く。規則は次の 4 つだけ:
//   1. 区域の名前 (match_area) は出典の名前のまま、住所と同じ正規化 (norm) で引く
//   2. 住所の頭から最も長く一致した、点のある節点 (区域、区域＋番号) を採る。同じ長さなら点の優先順
//      (point_priority の rank) の小さいもの
//   3. 区域の名前のあとに索引に無い文字があれば、読み飛ばして番号を引く。番号は区域そのものと、
//      地番を振る区域 (起番でない小字なら大字・丁目) で引く。頭の甲乙丙丁の付いた番号に点が無ければ、
//      字を外した番号でも引く (出典によって甲乙丙丁を番号に書くものと書かないものがある)
//   4. 住所の頭から番号まで読めたら、途中から読む読み方は使わない
import { norm } from "./norm";

export type Point = readonly [number, number];

/** 番号 1 つ分の点。rank は point_priority の rank (小さいほど優先) */
export type NumberPoint = {
  rank: number;
  point: Point;
  machiazaId: string | null;
  /** ABR の町字の表の行から引いたときの ID (住居表示の街区・住居、地番) */
  ids?: { blk_id?: string; rsdt_id?: string | null; rsdt2_id?: string | null; prc_id?: string };
  /** point_priority の point_type (rsdt・block は住居表示の番号、ほかは地番) */
  pointType: string;
  source: string;
  parts: readonly string[];
};

/** 区域 1 つ分の番号。has は点の無い番号も含めて、番号を 1 つでも持つか */
export type Numbers = { has: boolean; points: ReadonlyMap<string, NumberPoint> };

export type Area = {
  point: Point | null;
  /** 区域そのものの点か (false は下の町字の点の平均など) */
  own: boolean;
  machiazaId: string | null;
  /** 地番を振る区域の名前 (正規化したもの) */
  numbering: string | null;
};

export type Located = {
  point: Point;
  /** 一致した区域の名前 (正規化したもの) */
  area: string;
  machiazaId: string | null;
  number: NumberPoint | null;
  /** 住所の残りのうち、使わなかった後ろの部分 */
  rest: string;
};

const NUM = /^-?([甲乙丙丁]?[0-9]+[甲乙丙丁]?)(?:-([甲乙丙丁]?[0-9]+))?(?:-([0-9]+))?/;

type Option = { score: readonly [number, number, number, number]; located: Located };

const better = (a: Option["score"], b: Option["score"]): boolean => {
  const i = a.findIndex((x, j) => x !== b[j]);
  return i >= 0 && a[i] > b[i];
};

/** 区域の名前の頭の部分で、区域になっているもの (長い順) */
const parentAreas = (k: string, areas: ReadonlyMap<string, Area>): string[] =>
  Array.from({ length: k.length - 1 }, (_, i) => k.slice(0, k.length - 1 - i)).filter((p) =>
    areas.has(p),
  );

const options = (
  rest: string,
  s: number,
  e: number,
  areas: ReadonlyMap<string, Area>,
  numbers: (k: string) => Numbers,
): Option[] => {
  const k = rest.slice(s, e);
  const area = areas.get(k) as Area;
  const t = rest.slice(e);
  const numbering = area.numbering;
  const direct = NUM.exec(t);
  const at = direct ? -1 : t.search(/[甲乙丙丁]?[0-9]/);
  const skip =
    !direct && at >= 0 && (numbers(k).has || (numbering !== null && numbers(numbering).has));
  const m = direct ?? (skip ? NUM.exec(t.slice(at)) : null);
  const skipped = skip ? at : 0;
  const hits: { cover: number; rank: number; located: Located }[] = [];
  if (m) {
    const parts = m.slice(1).filter((x): x is string => x !== undefined);
    for (const kk of numbering === null ? [k] : [k, numbering]) {
      const node = numbers(kk).points;
      // 長い番号から引く。頭の甲乙丙丁の付いた番号に点が無ければ、字を外した番号でも引く
      const found = [...Array(parts.length).keys()]
        .map((j) => parts.slice(0, parts.length - j).join("-"))
        .flatMap((key) => [key, key.replace(/^[甲乙丙丁]/, "")].map((n) => ({ key, n })))
        .find(({ n }) => node.has(n));
      if (found === undefined) continue;
      const { key } = found;
      const hit = node.get(found.n) as NumberPoint;
      hits.push({
        cover: k.length + key.length,
        rank: hit.rank,
        located: {
          point: hit.point,
          area: kk,
          machiazaId: hit.machiazaId ?? areas.get(kk)?.machiazaId ?? null,
          number: hit,
          rest: t.slice(skipped + (m[0].startsWith("-") ? 1 : 0) + key.length),
        },
      });
    }
  }
  if (s === 0 || hits.length > 0) {
    const chain = [k, ...parentAreas(k, areas)];
    const own = chain.find((kk) => areas.get(kk)?.point && areas.get(kk)?.own);
    const any = own ?? chain.find((kk) => areas.get(kk)?.point);
    if (any !== undefined) {
      const a = areas.get(any) as Area;
      hits.push({
        cover: own === undefined ? 0 : any.length,
        rank: 9,
        located: {
          point: a.point as Point,
          area: any,
          machiazaId: a.machiazaId,
          number: null,
          rest: t,
        },
      });
    }
  }
  return hits.map((h) => ({ score: [h.cover, -h.rank, -skipped, -s], located: h.located }));
};

/**
 * 住所の残り rest (市区町村名より後) から点を引く。numbers は区域の名前 (正規化したもの) の番号で、
 * 照合の前に読んでおく (candidates が引く区域の名前を返す)
 */
export const locate = (
  rest: string,
  areas: ReadonlyMap<string, Area>,
  numbers: (k: string) => Numbers,
): Located | null => {
  const r = rest.replace(/-+$/, "") + "-";
  let best: Option | null = null;
  for (let s = 0; s < r.length; s++) {
    // 住所の頭から番号まで読めたら、途中から読む読み方は使わない
    if (s === 1 && best?.located.number) break;
    for (let e = r.length; e > s; e--) {
      if (!areas.has(r.slice(s, e))) continue;
      for (const o of options(r, s, e, areas, numbers))
        if (best === null || better(o.score, best.score)) best = o;
    }
  }
  return best?.located ?? null;
};

/** 照合で番号を引くかもしれない区域の名前。照合の前に、この区域の番号を読んでおく */
export const candidates = (rest: string, areas: ReadonlyMap<string, Area>): string[] => {
  const r = rest.replace(/-+$/, "") + "-";
  const keys = new Set<string>();
  for (let s = 0; s < r.length; s++)
    for (let e = r.length; e > s; e--) {
      const k = r.slice(s, e);
      const a = areas.get(k);
      // 後ろに数字が無ければ番号を引かない (options は数字の無い残りで番号を見ない)
      if (!a || !/[0-9]/.test(r.slice(e))) continue;
      keys.add(k);
      if (a.numbering !== null) keys.add(a.numbering);
    }
  return [...keys];
};

/** 住所の残り。住所を正規化し、市区町村名 (政令市は市名＋区名、区名、市名) より後ろを返す */
export const remainder = (
  address: string,
  city: { pref: string; county: string | null; city: string; ward: string | null },
): string => {
  const a = norm(address);
  const names = [norm(city.city + (city.ward ?? "")), norm(city.ward), norm(city.city)];
  const hit = names.find((n) => n !== "" && a.includes(n));
  if (hit !== undefined) return a.slice(a.indexOf(hit) + hit.length);
  return [city.pref, city.county].reduce<string>((s, n) => {
    const nn = norm(n);
    return nn !== "" && s.includes(nn) ? s.slice(s.indexOf(nn) + nn.length) : s;
  }, a);
};

export const EMPTY_NUMBERS: Numbers = { has: false, points: new Map() };
