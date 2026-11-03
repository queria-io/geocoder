// 「大字＋字○○＋番地」で、字○○が ABR の町字に無い住所。上流は町字止まりにする (残りを番号と読めない)。
// ABR はこうした地番を大字の町字に付けて持つので、字の名前を外して大字＋番地で当て直す。上流には無い段。
// 小字ごとに地番を振った大字で別の小字の番号を拾わないよう、親番の点は address_point の側で絞ってある
import type { MatchedResult } from "./model/model";

const PARCEL_PREFIX = new Set(Array.from("甲乙丙丁戊己庚辛壬癸"));

/** 残りの頭の字の名前と、その後ろ (番号から)。名前に数字を含むもの・番号の無いものは外さない */
export const splitAzaName = (rest: string): [string, string] | null => {
  const m = /^((?:小?字)?[^\d\s\-・]+?)(\d.*)$/u.exec(rest);
  if (!m) return null;
  // 字の名前は漢字とかな (ノ・ケ・ヶ などの片仮名 1 字を含む)。片仮名の続く名前や英字は
  // 建物名 (「サンハイツ101」) なので外さない (外すと部屋番号を地番と読む)
  if (/[A-Za-zＡ-Ｚａ-ｚ]|[ァ-ヺー]{2,}/u.test(m[1])) return null;
  // 番地の頭の甲・乙など (「舘ノ内甲2427」) は地番の一部なので残す
  const name = Array.from(m[1]);
  const last = name[name.length - 1];
  if (last !== undefined && PARCEL_PREFIX.has(last)) {
    if (name.length === 1) return null;
    return [name.slice(0, -1).join(""), last + m[2]];
  }
  return [m[1], m[2]];
};

/** 当て方の段が町字止まり (地番・住居表示に当たっていない) */
export const atMachiaza = (r: MatchedResult) =>
  r.match_level === "machiaza" || r.match_level === "machiaza_detail";

/** 当て直しで番号まで進んだか (地番・住居表示に当たったか、残りが番号から始まる) */
const advanced = (r: MatchedResult) => !atMachiaza(r) || /^\d/.test(r.unmatched_address?.[0] ?? "");

export const withAzaSkipped = async (
  r: MatchedResult,
  match: (address: string) => Promise<MatchedResult[]>,
): Promise<MatchedResult> => {
  if (!atMachiaza(r) || !r.ids.machiaza_id) return r;
  const split = splitAzaName(r.unmatched_address?.[0] ?? "");
  if (split === null) return r;
  const [, rest] = split;
  const retried = (await match(r.matched_address + rest)).find(
    (x) => x.ids.lg_code === r.ids.lg_code && x.ids.machiaza_id === r.ids.machiaza_id,
  );
  if (!retried || !advanced(retried)) return r;
  // 字の名前は確かめずに外したので、確からしさを元の答えの 9 割に下げる
  return { ...retried, score: Math.min(retried.score, r.score) * 0.9 };
};
