// 地番の住所の点を、直下のデータセットの address_point (住所ごとに選んだ点) で埋める。上流には無い段。
// ABR の地番は座標の付く筆が一部だけで、地番まで当たらない・当たっても点が無いと町字の代表点になる
// (数百 m ずれる)。address_point は筆の点が無い住所に親番 (「28番地10」の「28」) の点を前もって入れてある
import { coordinatesLevel } from "./answer";
import type { CoordinateLevel, MatchedResult } from "./model/model";
import type { BasicResult } from "./repository/types";
import { atMachiaza } from "./skip_aza";

/** address_point の表の 1 行 */
export type PointRow = {
  system: string;
  num1: string;
  num2: string | null;
  num3: string | null;
  point_type: string | null;
  source: string | null;
  lng: number | null;
  lat: number | null;
};

export const POINT_COLUMNS = [
  "system",
  "num1",
  "num2",
  "num3",
  "point_type",
  "source",
  "lng",
  "lat",
];

export const PARCEL_PARENT: CoordinateLevel = "parcel_parent";

export const ISJ_ATTRIBUTION = "「街区レベル位置参照情報」（国土交通省）を加工して作成";

/**
 * 町字の代表点まで落ちたもの。地番まで当たっても筆にも町字にも点が無ければ (座標なし) 同じに扱う。
 * 住居表示に当たって座標の無いものは外す (残りの番号は地番ではない)
 */
const pointAtMachiaza = (r: MatchedResult): boolean => {
  const level = coordinatesLevel(r);
  return level === null
    ? r.match_level === "parcel" || atMachiaza(r)
    : level === "machiaza" || level === "machiaza_detail";
};

/**
 * 地番の親番。地番まで当たっていればその地番 1、町字止まりなら残りの頭の番号。
 * 番号の後ろは終わり・「-」・「番」だけを認める (「2F」や「9丁目28」の頭の数字は親番ではない)
 */
export const parentNumber = (r: MatchedResult): string | null =>
  r.structured_address.prc_num1 ??
  /^(\d+)(?=$|-|番)/.exec(r.unmatched_address?.[0] ?? "")?.[1] ??
  null;

type Num = readonly [string, string | null, string | null];

/** 住所自身の番号。地番まで当たっていればその地番、町字止まりなら残りの頭の「28-10」「28番地10」 */
const ownNumber = (r: MatchedResult, parent: string): Num => {
  const { prc_num1: n1, prc_num2: n2, prc_num3: n3 } = r.structured_address;
  if (n1 !== null) return [n1, n2, n3];
  const m = /^\d+(?:(?:番地?|-)(\d+)(?:-(\d+))?(?!\d))?/.exec(r.unmatched_address?.[0] ?? "");
  return [parent, m?.[1] ?? null, m?.[2] ?? null];
};

/**
 * 引く番号の順: 住所自身の番号、次に親の番号 (12-3-4 なら 12-3、12)。own は住所自身の番号か
 * (親の番号で引いた点は、その行が筆の点でも住所自身の点ではない)
 */
const numbers = (r: MatchedResult, parent: string): { num: Num; own: boolean }[] => {
  const own = ownNumber(r, parent);
  const parents: Num[] = [
    ...(own[2] === null ? [] : [[parent, own[1], null] as const]),
    ...(own[1] === null ? [] : [[parent, null, null] as const]),
  ];
  return [{ num: own, own: true }, ...parents.map((num) => ({ num, own: false }))];
};

/**
 * 引く町字の順: 町字そのもの、次に地番が振られた区域の町字 (小字が起番でなければ大字・町)。
 * 区域の中で地番が一意でなければ (小字ごとに地番を振った大字・町)、区域では探さない
 */
const areas = (machiazaId: string, town: BasicResult | null): string[] =>
  town?.numberingId && town.parcelUnique && town.numberingId !== machiazaId
    ? [machiazaId, town.numberingId]
    : [machiazaId];

const same = (a: PointRow, [n1, n2, n3]: Num) =>
  a.system === "parcel" && a.num1 === n1 && a.num2 === n2 && a.num3 === n3;

const levelOf = (row: PointRow, own: boolean): CoordinateLevel =>
  own && row.point_type === "parcel" ? "parcel" : PARCEL_PARENT;

export const withAddressPoint = async (
  r: MatchedResult,
  load: (lgCode: string, machiazaId: string) => Promise<PointRow[]>,
  town: (lgCode: string, machiazaId: string) => Promise<BasicResult | null>,
): Promise<MatchedResult> => {
  const { lg_code: lgCode, machiaza_id: machiazaId } = r.ids;
  const parent = parentNumber(r);
  if (!pointAtMachiaza(r) || !lgCode || !machiazaId || parent === null) return r;
  const ids = areas(machiazaId, await town(lgCode, machiazaId));
  for (const { num, own } of numbers(r, parent))
    for (const id of ids) {
      const hit = (await load(lgCode, id)).find(
        (x) => same(x, num) && x.lng !== null && x.lat !== null,
      );
      if (hit)
        return {
          ...r,
          coordinates: [hit.lng as number, hit.lat as number],
          coordinate_level: levelOf(hit, own),
        };
    }
  return withBlockPoint(r, load, lgCode, machiazaId, parent);
};

/**
 * 地番の区域の町 (住居表示でない) では、位置参照情報が「○番」の点を街区として持つことがある
 * (ひたちなか市小砂町一丁目の 8 番)。地番にも親番にも点が無ければ、同じ番号の街区の点を使う
 */
const withBlockPoint = async (
  r: MatchedResult,
  load: (lgCode: string, machiazaId: string) => Promise<PointRow[]>,
  lgCode: string,
  machiazaId: string,
  parent: string,
): Promise<MatchedResult> => {
  if (r.ids.rsdt_addr_flg !== "0") return r;
  const hit = (await load(lgCode, machiazaId)).find(
    (x) =>
      x.system === "rsdt" &&
      x.point_type === "block" &&
      x.num1 === parent &&
      x.num2 === null &&
      x.lng !== null &&
      x.lat !== null,
  );
  return hit
    ? { ...r, coordinates: [hit.lng as number, hit.lat as number], coordinate_level: PARCEL_PARENT }
    : r;
};
