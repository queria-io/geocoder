// 住居表示 (街区・住居) と地番まで当てる段。上流の two_stage.go・two_stage_search.go の写し
// (upstream/UPSTREAM のコミット)。地番はまだ表が無いので何も返さない。返さなければ上流と同じく町字までの結果に戻る
import { IsASCIIDigit } from "../char/char";
import {
  FormatAddress,
  MaxChomeNumber,
  type MatchedResult,
  type StructuredAddress,
} from "../model/model";
import { ResidentialResultToNormalized } from "../repository/rsdtdsp";
import type { NormalizeContext } from "./context";
import type { Impl } from "./matcher";
import type { ParsedAddress } from "./parsed_addr";
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
  return [{ ...result, ids, structured_address: sa, matched_address: FormatAddress(sa) }];
};

export const tryTwoStageResidential = async (
  n: Impl,
  nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => {
  const basic = nctx.State.BasicResults[0];
  if (!basic?.ids.machiaza_id) return null;
  // 丁目のある町なら、最初の番号を丁目と読み替える ("舞浜:2-11" → "舞浜2@:11")
  const converted = basic.machiaza.hasChome ? convertColonToChome(nctx.Input.SearchAddr) : null;
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

export const tryTwoStageParcel = async (
  _n: Impl,
  _nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => null;
