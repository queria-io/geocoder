// 住所の残り (市区町村名より後) から点を引く。規則は次の 4 つだけ:
//   1. 区域の名前 (match_area) は出典の名前のまま、住所と同じ正規化 (norm) で引く
//   2. 住所の頭から最も長く一致した、点のある節点 (区域、区域＋番号) を採る。同じ長さなら読み飛ばした文字の
//      少ないもの、次に点の優先順 (point_priority の rank) の小さいもの
//   3. 区域の名前のあとに索引に無い文字があれば、読み飛ばして番号を引く。番号は区域そのものと、
//      地番を振る区域 (起番でない小字なら大字・丁目) で引く。書かれたとおりの番号に点が無ければ、
//      頭の甲乙丙丁を外した番号でも引く (出典によって甲乙丙丁を番号に書くものと書かないものがある)。
//      外した字は照合できなかった部分に残す。住所の番号に甲乙丙丁が無く、甲乙丙丁を付けた番号にだけ
//      点があれば、当たったものをすべて候補として返す。「丁目」と書かれた数字は地番として読まない
//      (区域に無い丁目は、読み飛ばす文字として扱う)
//   4. 住所の頭から番号まで読めたら、途中から読む読み方は使わない
import { CHOME, norm } from "./norm";

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
  /** 住所の書き方からは決められない、ほかの候補 (甲乙丙丁の違いだけの番号) */
  others?: Located[];
};

const NUM = /^-?([甲乙丙丁]?[0-9]+[甲乙丙丁]?)(?:-([甲乙丙丁]?[0-9]+))?(?:-([0-9]+))?/;

type Option = { score: readonly [number, number, number, number, number]; located: Located };

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
  marked: string,
  s: number,
  e: number,
  areas: ReadonlyMap<string, Area>,
  numbers: (k: string) => Numbers,
): Option[] => {
  const k = rest.slice(s, e);
  const area = areas.get(k) as Area;
  const t = rest.slice(e);
  const numbering = area.numbering;
  // 「丁目」と書かれた数字は地番として読まない (区域に無い丁目なら、読み飛ばして後ろの番号を引く)
  const nums = [...marked.slice(e).matchAll(/[甲乙丙丁]?[0-9]+(=?)/g)];
  const direct = nums[0]?.[1] === "" ? NUM.exec(t) : null;
  const at = direct ? -1 : (nums.find((x) => x[1] === "")?.index ?? -1);
  const skip =
    !direct && at >= 0 && (numbers(k).has || (numbering !== null && numbers(numbering).has));
  const m = direct ?? (skip ? NUM.exec(t.slice(at)) : null);
  const skipped = skip ? at : 0;
  const hits: { cover: number; guessed: number; rank: number; located: Located }[] = [];
  if (m) {
    const parts = m.slice(1).filter((x): x is string => x !== undefined);
    const keys = [...Array(parts.length).keys()].map((j) =>
      parts.slice(0, parts.length - j).join("-"),
    );
    // 番号を引く順: 書かれたとおりの番号、頭の甲乙丙丁を外した番号、(番号に甲乙丙丁が無ければ) 甲乙丙丁を付けた番号。
    // それぞれ長い順に引き、区域そのものか地番を振る区域で当たった段で止める。甲乙丙丁を付けた番号は、
    // 当たったものをすべて候補にする (住所からはどれか決められない)
    const stages: { ns: (key: string) => string[]; drop: boolean; add: boolean }[] = [
      { ns: (key) => [key], drop: false, add: false },
      { ns: (key) => (/^[甲乙丙丁]/.test(key) ? [key.slice(1)] : []), drop: true, add: false },
      {
        ns: (key) => (/^[0-9]/.test(key) ? [..."甲乙丙丁"].map((c) => c + key) : []),
        drop: false,
        add: true,
      },
    ];
    for (const stage of stages) {
      for (const kk of numbering === null ? [k] : [k, numbering]) {
        const node = numbers(kk).points;
        const found = keys
          .map((key) => ({ key, ns: stage.ns(key).filter((n) => node.has(n)) }))
          .find((x) => x.ns.length > 0);
        if (found === undefined) continue;
        // 照合できた文字数は住所に書かれた番号の長さで数える。外した字は照合できなかった部分に残す
        const dropped = stage.drop ? found.key[0] : "";
        const all = found.ns
          .map((n) => node.get(n) as NumberPoint)
          .sort((a, b) => a.rank - b.rank)
          .map((hit): Located => ({
            point: hit.point,
            area: kk,
            machiazaId: hit.machiazaId ?? areas.get(kk)?.machiazaId ?? null,
            number: hit,
            rest: dropped + t.slice(skipped + (m[0].startsWith("-") ? 1 : 0) + found.key.length),
          }));
        const first = all[0] as Located;
        hits.push({
          cover: k.length + found.key.length - dropped.length,
          guessed: stage.add ? 1 : 0,
          rank: (first.number as NumberPoint).rank,
          located: all.length > 1 ? { ...first, others: all.slice(1) } : first,
        });
      }
      if (hits.length > 0) break;
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
        guessed: 0,
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
  return hits.map((h) => ({
    score: [h.cover, -h.guessed, -skipped, -h.rank, -s],
    located: h.located,
  }));
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
  const marked = rest.replace(/[-=]+$/, "") + "-";
  const r = marked.replaceAll(CHOME, "-");
  let best: Option | null = null;
  for (let s = 0; s < r.length; s++) {
    // 住所の頭から番号まで読めたら、途中から読む読み方は使わない
    if (s === 1 && best?.located.number) break;
    for (let e = r.length; e > s; e--) {
      if (!areas.has(r.slice(s, e))) continue;
      for (const o of options(r, marked, s, e, areas, numbers))
        if (best === null || better(o.score, best.score)) best = o;
    }
  }
  return best?.located ?? null;
};

/** 照合で番号を引くかもしれない区域の名前。照合の前に、この区域の番号を読んでおく */
export const candidates = (rest: string, areas: ReadonlyMap<string, Area>): string[] => {
  const r = rest.replaceAll(CHOME, "-").replace(/-+$/, "") + "-";
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
  const a = norm(address, true);
  const names = [norm(city.city + (city.ward ?? "")), norm(city.ward), norm(city.city)];
  const hit = names.find((n) => n !== "" && a.includes(n));
  if (hit !== undefined) return a.slice(a.indexOf(hit) + hit.length);
  return [city.pref, city.county].reduce<string>((s, n) => {
    const nn = norm(n);
    return nn !== "" && s.includes(nn) ? s.slice(s.indexOf(nn) + nn.length) : s;
  }, a);
};

export const EMPTY_NUMBERS: Numbers = { has: false, points: new Map() };
