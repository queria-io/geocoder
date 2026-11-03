// 住居表示 (街区・住居) と地番まで当てる段。上流の two_stage.go・two_stage_search.go・kyoto.go の写し
// (upstream/UPSTREAM のコミット)。当たらなければ null を返し、上流と同じく町字までの結果に戻る
import { IsASCIIDigit } from "../char/char";
import {
  FormatAddress,
  MaxChomeNumber,
  type MatchedResult,
  type StructuredAddress,
} from "../model/model";
import { ParcelResultToNormalized, type ParcelRow } from "../repository/parcel";
import { ResidentialResultToNormalized } from "../repository/rsdtdsp";
import { KanaSpellings } from "../util/char";
import type { NormalizeContext } from "./context";
import type { Impl } from "./matcher";
import {
  numericParts,
  parcelNumberPrefix,
  parsedString,
  parseSearchAddr,
  type ParsedAddress,
} from "./parsed_addr";
import { convertColonToChome } from "./search_addr";
import { setTwoStageUnmatchedAddress } from "./unmatched";

/** 丁目の無い町字 ID の末尾 3 桁を丁目の番号にする。"0043000" と "2" → "0043002" */
export const adjustMachiazaIDForChome = (machiazaId: string, chomeNum: string): string => {
  if (machiazaId.length !== 7 || chomeNum === "") return machiazaId;
  const digits = Array.from(chomeNum).filter(IsASCIIDigit).join("");
  if (digits === "") return machiazaId;
  const chome = Number(digits);
  if (chome <= 0 || chome > MaxChomeNumber) return machiazaId;
  return machiazaId.slice(0, 4) + String(chome).padStart(3, "0");
};

const searchResidential = async (
  n: Impl,
  lgCode: string,
  machiazaId: string,
  parsed: ParsedAddress,
): Promise<MatchedResult | null> => {
  const [BlkNum, RsdtNum = "", RsdtNum2 = ""] = parsed.Numbers;
  if (BlkNum === undefined) return null;
  // 検索文字に丁目の印があれば ("舞浜2@:11")、手元の町字 ID は丁目の無い町のことがある。丁目の町字 ID に直す
  const id =
    parsed.HasChome && parsed.Chome !== ""
      ? adjustMachiazaIDForChome(machiazaId, parsed.Chome)
      : machiazaId;
  const best = await n.repo.FindResidentialBestMatch(lgCode, id, { BlkNum, RsdtNum, RsdtNum2 });
  if (!best) return null;
  const result = ResidentialResultToNormalized(best.row);
  const unmatched =
    best.level === 1 && RsdtNum !== ""
      ? "-" + RsdtNum + (RsdtNum2 !== "" ? "-" + RsdtNum2 : "")
      : best.level === 2 && RsdtNum2 !== ""
        ? "-" + RsdtNum2
        : "";
  return unmatched === "" ? result : { ...result, unmatched_address: [unmatched] };
};

/** dst の空いている欄を src で埋める */
const mergeFrom = (dst: StructuredAddress, src: StructuredAddress): StructuredAddress =>
  Object.fromEntries(
    Object.entries(dst).map(([k, v]) => [k, v ?? src[k as keyof StructuredAddress]]),
  ) as StructuredAddress;

/**
 * 番号の点に座標が無ければ町字の代表点で埋める。上流は座標を null のまま返す。
 * どの点から取ったかは coordinate_level に残す
 */
const withMachiazaPoint = (result: MatchedResult, basic: MatchedResult) =>
  result.coordinates !== null || basic.coordinates === null
    ? {}
    : { coordinates: basic.coordinates, coordinate_level: basic.match_level };

const normalizeResidentialWithBasic = async (
  n: Impl,
  basicResults: MatchedResult[],
  parsed: ParsedAddress,
): Promise<MatchedResult[] | null> => {
  const basic = basicResults[0];
  const { lg_code: lgCode, machiaza_id: machiazaId } = basic?.ids ?? {};
  if (!lgCode || !machiazaId) return null;
  const result = await searchResidential(n, lgCode, machiazaId, parsed);
  if (!result) return null;
  // 住居表示で当たったものは住居表示を実施した所なので、フラグは常に 1 (上流の issue #262)
  const ids = { ...result.ids, rsdt_addr_flg: result.ids.rsdt_addr_flg ?? "1" };
  const merged = mergeFrom(result.structured_address, basic.structured_address);
  const sa =
    merged.chome === null && parsed.HasChome && parsed.Chome !== ""
      ? { ...merged, chome: parsed.Chome + "丁目" }
      : merged;
  return [
    {
      ...result,
      ...withMachiazaPoint(result, basic),
      ids,
      structured_address: sa,
      matched_address: FormatAddress(sa),
    },
  ];
};

export const tryTwoStageResidential = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  const basic = nctx.State.BasicResults[0];
  if (!basic?.ids.machiaza_id) return null;
  // 丁目のある町なら、最初の番号を丁目と読み替える ("舞浜:2-11" → "舞浜2@:11")。
  // 当たった町字がもう丁目まで持っていれば ("新金岡町5丁")、最初の番号は街区なので読み替えない。
  // 上流はここを分けず、"新金岡町5丁1-4" を 1丁 の 4番 に当ててしまう
  const converted =
    basic.machiaza.hasChome && basic.structured_address.chome === null
      ? convertColonToChome(nctx.Input.SearchAddr)
      : null;
  const chomeConverted =
    converted !== null && converted.HasChome !== nctx.Input.SearchAddr.HasChome;
  const searchAddr = chomeConverted ? converted : nctx.Input.SearchAddr;
  // 住居表示の住所が無い町字は読まない。丁目に読み替えたときは、丁目の町字 ID の下にあるかもしれないので読む
  if (basic.machiaza.rsdtdspCount === 0 && !chomeConverted) return null;
  const results = await normalizeResidentialWithBasic(n, nctx.State.BasicResults, searchAddr);
  return (
    results?.map((r) => setTwoStageUnmatchedAddress(r, nctx.Input.NormalizedAddr, searchAddr)) ??
    null
  );
};

const isBaseMachiazaId = (id: string): boolean => id.length !== 7 || id.slice(4) === "000";

/** 町名と数字の間に書かれた地番の頭の文字 (甲・イなど)。当たった町字の名前がその文字で終わるなら名前の一部 */
const parcelPrefixFor = (parsed: ParsedAddress, basic: MatchedResult): string => {
  const prefix = parcelNumberPrefix(parsed);
  return prefix === "" || basic.matched_address.endsWith(prefix) ? "" : prefix;
};

/** 京都の通り名なら、地番は同じ町 (末尾 000) の下に置かれている。小字は別の場所なので借りない */
const canUseBaseMachiaza = (machiazaId: string, basic: MatchedResult): boolean =>
  basic.structured_address.kyoto_st !== null && !isBaseMachiazaId(machiazaId);

const searchParcel = async (
  n: Impl,
  lgCode: string,
  machiazaId: string,
  parsed: ParsedAddress,
  basic: MatchedResult,
  chomeId?: string,
): Promise<MatchedResult | null> => {
  const [num1, num2 = "", num3 = ""] = numericParts(parsed);
  if (num1 === undefined) return null;
  const parcelCount = basic.machiaza.parcelCount;
  const useBase = parcelCount === 0 && canUseBaseMachiaza(machiazaId, basic);
  if (parcelCount === 0 && !useBase) return null;
  const prefix = parcelPrefixFor(parsed, basic);
  // 頭の文字を付けた形を先に試す (同じ町に 402 と 甲402 があれば、書いてあるほう)
  const num1Forms = [...(prefix !== "" ? KanaSpellings(prefix).map((p) => p + num1) : []), num1];
  const find = async (id: string): Promise<ParcelRow | null> => {
    for (const PrcNum1 of num1Forms)
      for (const PrcNum2 of KanaSpellings(num2))
        for (const PrcNum3 of KanaSpellings(num3)) {
          const hit = await n.repo.FindParcelExact(lgCode, id, { PrcNum1, PrcNum2, PrcNum3 });
          if (hit) return hit;
        }
    return null;
  };
  if (chomeId !== undefined) {
    const hit = await find(chomeId);
    return hit ? ParcelResultToNormalized(hit) : null;
  }
  if (parcelCount > 0) {
    const hit = await find(machiazaId);
    if (hit) return ParcelResultToNormalized(hit);
  }
  if (useBase) {
    const hit = await find(machiazaId.slice(0, 4) + "000");
    if (!hit) return null;
    // 答えには、地番が置かれた町ではなく住所が当たった通り名の町字 ID を出す
    const result = ParcelResultToNormalized(hit);
    return { ...result, ids: { ...result.ids, machiaza_id: machiazaId } };
  }
  return null;
};

const normalizeParcelWithBasic = async (
  n: Impl,
  basicResults: MatchedResult[],
  parsed: ParsedAddress,
  chomeId?: string,
): Promise<MatchedResult[] | null> => {
  const basic = basicResults[0];
  const { lg_code: lgCode, machiaza_id: machiazaId } = basic?.ids ?? {};
  if (!lgCode || !machiazaId) return null;
  const result = await searchParcel(n, lgCode, machiazaId, parsed, basic, chomeId);
  if (!result) return null;
  const ids = { ...result.ids, rsdt_addr_flg: result.ids.rsdt_addr_flg ?? basic.ids.rsdt_addr_flg };
  const sa = mergeFrom(result.structured_address, basic.structured_address);
  return [
    {
      ...result,
      ...withMachiazaPoint(result, basic),
      ids,
      structured_address: sa,
      matched_address: FormatAddress(sa),
    },
  ];
};

/** 地番の表に通り名は無いので、町字までの答えから通り名と、通り名の町字 ID・住居表示の印を移す */
const mergeKyotoSt = (results: MatchedResult[], basic: MatchedResult): MatchedResult[] =>
  basic.structured_address.kyoto_st === null
    ? results
    : results.map((r) => {
        if (r.structured_address.kyoto_st !== null) return r;
        const sa = { ...r.structured_address, kyoto_st: basic.structured_address.kyoto_st };
        return {
          ...r,
          structured_address: sa,
          ids: {
            ...r.ids,
            machiaza_id: basic.ids.machiaza_id ?? r.ids.machiaza_id,
            rsdt_addr_flg: basic.ids.rsdt_addr_flg ?? r.ids.rsdt_addr_flg,
          },
          matched_address: FormatAddress(sa),
        };
      });

/** 通り名を外した検索文字。"京都市中京区上本能寺前町:488" */
const searchAddrWithoutKyotoSt = (sa: StructuredAddress, afterColon: string): string =>
  [sa.city, sa.ward, sa.oaza_cho, sa.chome, sa.koaza].map((v) => v ?? "").join("") +
  (afterColon !== "" ? ":" + afterColon : "");

export const tryTwoStageParcel = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  const basic = nctx.State.BasicResults[0];
  if (!basic?.ids.machiaza_id) return null;
  const machiazaId = basic.ids.machiaza_id;
  const searchAddr =
    basic.structured_address.kyoto_st !== null
      ? searchAddrWithoutKyotoSt(basic.structured_address, nctx.Input.SearchAddr.Numbers.join("-"))
      : parsedString(nctx.Input.SearchAddr);
  // 地番の無い町 (末尾 000) は探さない。丁目のある町は丁目の町字 ID の下にあるかもしれないので探す
  if (basic.machiaza.parcelCount === 0 && isBaseMachiazaId(machiazaId) && !basic.machiaza.hasChome)
    return null;
  const finalize = (results: MatchedResult[], used: ParsedAddress) =>
    mergeKyotoSt(
      results.map((r) => setTwoStageUnmatchedAddress(r, nctx.Input.NormalizedAddr, used)),
      basic,
    );
  // 丁目のある町で丁目の印が無ければ、まず最初の番号を丁目と読み ("南2条西1-5-2F" → 1丁目 5番)、
  // 当たらなければそのまま ("舞浜2-11" → 地番 2-11)。住居表示の段と同じく、当たった町字が
  // もう丁目まで持っていれば読み替えない (上流は読み替える)。
  // 丁目と読んだ番号の地番は、その丁目の町字 ID の下で探す。上流は丁目を外した番号を丁目の無い町で探すので、
  // 丁目のある町の「1762番10」を地番 10 に当ててしまう。丁目にならない番号 (1762) なら読み替えない
  const parsed = parseSearchAddr(searchAddr);
  if (basic.machiaza.hasChome && basic.structured_address.chome === null && !parsed.HasChome) {
    const adjusted = convertColonToChome(parsed);
    const chomeId = adjustMachiazaIDForChome(machiazaId, adjusted.Chome);
    if (parsedString(adjusted) !== searchAddr && chomeId !== machiazaId) {
      const results = await normalizeParcelWithBasic(n, nctx.State.BasicResults, adjusted, chomeId);
      if (results) return finalize(results, adjusted);
    }
  }
  const results = await normalizeParcelWithBasic(n, nctx.State.BasicResults, parsed);
  return results ? finalize(results, parsed) : null;
};
