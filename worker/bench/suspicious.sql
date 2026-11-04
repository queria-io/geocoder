-- 照合の記録 (src/request_log.ts) から、誤照合の疑いがある住所を数える。記録には正解の座標が無いので、
-- 入力に書かれた「字」の名前が結果に無いもの (字を読み飛ばして別の町字に当てた疑い) を拾う。
-- 拾った住所は、正解の座標を持つオープンデータで同じ書き方の住所を探し、ベンチマークに足す材料にする。
-- 使い方: duckdb -c "SET VARIABLE logs = 's3://queria-logs/geocoder/requests/**/*.parquet'; .read bench/suspicious.sql"
WITH logs AS (
  SELECT * FROM read_parquet(getvariable('logs'))
  WHERE outcome IN ('ok', 'remainder') AND matched_address IS NOT NULL
),
aza AS (
  SELECT
    address, matched_address, unmatched_address, lg_code,
    -- 「字」の後の名前 (番号・「番地」・丁目の前まで)。「大字」の名前も含む
    regexp_extract_all(address, '字([^0-9０-９一二三四五六七八九十〇番地丁目\-－‐ー\s　]+)', 1) AS names
  FROM logs
  WHERE contains(address, '字')
)
SELECT
  address, matched_address, unmatched_address, lg_code,
  list_filter(names, n -> NOT contains(matched_address || coalesce(unmatched_address, ''), n)) AS missing,
  count(*) AS requests
FROM aza
WHERE len(list_filter(names, n -> NOT contains(matched_address || coalesce(unmatched_address, ''), n))) > 0
GROUP BY ALL
ORDER BY requests DESC, address
LIMIT 200;
