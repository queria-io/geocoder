// 照合しきれなかった住所の記録。どんな書き方の住所が照合できないかを集め、照合の改善に使う。
// 誰が入力したかは残さない (IP アドレスは書かない)。Workers Analytics Engine は 3 か月で消える
import type { MatchedResult } from "./model/model";

/** 番地まで照合できたとみなす段 */
const FINE = new Set(["rsdtdsp_rsdt", "rsdtdsp_blk", "parcel"]);

/** 照合しきれなかった理由。照合できていれば null */
export const missReason = (results: readonly MatchedResult[]): string | null => {
  const [top] = results;
  if (top === undefined) return "none";
  if ((top.candidates ?? 1) > 1) return "ambiguous";
  if (!FINE.has(top.match_level)) return "coarse";
  return top.unmatched_address === null ? null : "remainder";
};

/** Analytics Engine に書く 1 行。照合できていれば null */
export const missPoint = (
  address: string,
  results: readonly MatchedResult[],
): AnalyticsEngineDataPoint | null => {
  const reason = missReason(results);
  if (reason === null) return null;
  const top = results[0];
  return {
    indexes: [reason],
    blobs: [
      reason,
      address,
      top?.match_level ?? "",
      top?.matched_address ?? "",
      (top?.unmatched_address ?? []).join(""),
      top?.ids.lg_code ?? "",
    ],
    doubles: [top?.candidates ?? 0],
  };
};
