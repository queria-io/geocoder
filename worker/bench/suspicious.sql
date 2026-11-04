-- 照合の記録 (src/request_log.ts) から、誤照合の疑いがある住所を数える。記録には正解の座標が無いので、
-- 入力にある漢字・かなのうち、結果 (照合した住所と照合できずに残った部分) のどこにも無い文字を拾う。
-- 「字」の名前を読み飛ばした、別の町字に当てた、などで入力の地名の一部が結果から消えたものが並ぶ。
-- 市区町村を推定した結果 (candidates が 2 以上) と、同じ名前の別の町に当てたものは文字が消えないので、
-- candidates と、書き方の型ごとのベンチマーク (gate.ts) で見る。
-- 拾った住所の書き方は、正解の座標を持つオープンデータで同じ書き方の住所を探し、ベンチマークに足す。
-- 使い方: duckdb -c "SET VARIABLE logs = 's3://queria-logs/geocoder/requests/**/*.parquet'; .read bench/suspicious.sql"
WITH logs AS (
  SELECT
    *,
    replace(replace(address, 'ヶ', 'ケ'), 'ヵ', 'ケ') AS input,
    replace(replace(matched_address || coalesce(unmatched_address, ''), 'ヶ', 'ケ'), 'ヵ', 'ケ') AS result
  FROM read_parquet(getvariable('logs'))
  WHERE matched_address IS NOT NULL
),
checked AS (
  SELECT
    *,
    -- 番号に付く文字 (番地・丁目・号など) と「字」「大」は結果に書かれないことがあるので数えない
    list_distinct(
      list_filter(
        regexp_extract_all(input, '[\p{Han}\p{Hiragana}\p{Katakana}ー]'),
        ch -> NOT contains(result, ch) AND NOT contains('大字小番地丁目号の之ノ条線区画', ch)
      )
    ) AS chars
  FROM logs
),
flagged AS (
  SELECT outcome, address, matched_address, unmatched_address, lg_code, candidates,
    array_to_string(chars, '') AS missing
  FROM checked
  WHERE len(chars) > 0 OR candidates > 1
)
SELECT outcome, address, matched_address, unmatched_address, lg_code, candidates, missing, count(*) AS requests
FROM flagged
GROUP BY outcome, address, matched_address, unmatched_address, lg_code, candidates, missing
ORDER BY length(missing) = 0, requests DESC, address
LIMIT 500;
