// 照合の記録。入力の住所と照合の結果を、照合の改善と地域ごとの利用状況の集計に使う。
// 誰が入力したかは残さない (IP アドレスは書かない)。
// Cloudflare Pipelines のストリームの HTTP の口に 1 住所 1 件送り、数分ごとにまとめて R2 に Parquet で書かせる。
// 送り先と鍵はシークレット (REQUEST_LOG_URL・REQUEST_LOG_TOKEN) に置き、リポジトリには書かない。
// 無ければ何も送らない (自分の環境で動かすときは記録しない)。
// ストリームの列は送る形と同じでなければ黙って捨てられるので、RequestLogEntry を変えたら
// ストリームを作り直す (列の一覧は REQUEST_LOG_STREAM_SCHEMA)
import type { MatchedResult } from "./model/model";

/** 番地まで照合できたとみなす段 */
const FINE = new Set(["rsdtdsp_rsdt", "rsdtdsp_blk", "parcel"]);

/**
 * 照合の結果の分類。none は結果なし、ambiguous は市区町村の候補が複数、coarse は番地まで
 * 照合できない、remainder は照合できない文字が残る、ok はそれ以外
 */
export const outcomeOf = (results: readonly MatchedResult[]): string => {
  const [top] = results;
  if (top === undefined) return "none";
  if ((top.candidates ?? 1) > 1) return "ambiguous";
  if (!FINE.has(top.match_level)) return "coarse";
  return top.unmatched_address === null ? "ok" : "remainder";
};

export type RequestLogEntry = {
  ts: string;
  endpoint: string;
  address: string;
  outcome: string;
  match_level: string | null;
  coordinates_level: string | null;
  matched_address: string | null;
  unmatched_address: string | null;
  lg_code: string | null;
  machiaza_id: string | null;
  candidates: number;
};

/** ストリームを作るときの列 */
export const REQUEST_LOG_STREAM_SCHEMA: {
  fields: { name: string; type: string; required: boolean }[];
} = {
  fields: [
    { name: "ts", type: "timestamp", required: true },
    { name: "endpoint", type: "string", required: true },
    { name: "address", type: "string", required: true },
    { name: "outcome", type: "string", required: true },
    { name: "match_level", type: "string", required: false },
    { name: "coordinates_level", type: "string", required: false },
    { name: "matched_address", type: "string", required: false },
    { name: "unmatched_address", type: "string", required: false },
    { name: "lg_code", type: "string", required: false },
    { name: "machiaza_id", type: "string", required: false },
    { name: "candidates", type: "int64", required: true },
  ],
};

/** 1 住所の記録。先頭の結果で書く */
export const logEntry = (
  endpoint: string,
  address: string,
  results: readonly MatchedResult[],
  now: Date = new Date(),
): RequestLogEntry => {
  const top = results[0];
  return {
    ts: now.toISOString(),
    endpoint,
    address,
    outcome: outcomeOf(results),
    match_level: top?.match_level ?? null,
    coordinates_level: top === undefined ? null : (top.coordinate_level ?? top.match_level),
    matched_address: top?.matched_address ?? null,
    unmatched_address: top?.unmatched_address?.join("") ?? null,
    lg_code: top?.ids.lg_code ?? null,
    machiaza_id: top?.ids.machiaza_id ?? null,
    candidates: top === undefined ? 0 : (top.candidates ?? 1),
  };
};

/** 記録の送り先。どちらかが無ければ送らない */
export type RequestLogEnv = { REQUEST_LOG_URL?: string; REQUEST_LOG_TOKEN?: string };

/** ストリームに送る。送り先が無ければ何もしない */
export const sendLog = async (
  env: RequestLogEnv,
  entries: RequestLogEntry[],
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  if (!env.REQUEST_LOG_URL || !env.REQUEST_LOG_TOKEN || entries.length === 0) return;
  const res = await fetcher(env.REQUEST_LOG_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REQUEST_LOG_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(entries),
  });
  if (!res.ok) throw new Error(`request log: ${res.status}`);
};
