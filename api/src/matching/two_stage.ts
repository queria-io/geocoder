// 住居表示 (街区・住居) と地番まで当てる段 (上流の two_stage.go・two_stage_search.go)。
// まだ写していないので、何も返さない。返さなければ上流と同じく町字までの結果に戻る
import type { MatchedResult } from "../model/model";
import type { NormalizeContext } from "./context";
import type { Impl } from "./matcher";

export const tryTwoStageResidential = async (
  _n: Impl,
  _nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => null;

export const tryTwoStageParcel = async (
  _n: Impl,
  _nctx: NormalizeContext,
): Promise<MatchedResult[] | null> => null;
