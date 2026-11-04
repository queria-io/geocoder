-- 照合の記録 (src/request_log.ts) から、誤照合の疑いがある住所を数える。記録には正解の座標が無いので、
-- 入力と結果の地名の文字を両方向に比べる。
-- - missing: 入力にある漢字・かなのうち、結果 (照合した住所と照合できずに残った部分) のどこにも無い文字。
--   「字」の名前を読み飛ばしたものなど、入力の地名の一部が結果から消えたものが並ぶ
-- - extra: 照合した住所の町字の部分 (都道府県・郡・市区町村を除く) にあって、入力に無い文字。
--   鞭打野 → 金打坊、上荒町 → 下荒町のように、入力と違う町字に当てたものが並ぶ
-- 市区町村を推定した結果 (candidates が 2 以上) と、同じ名前の別の町に当てたものは文字では分からないので、
-- candidates と、書き方の型ごとのベンチマーク (gate.ts) で見る。
-- 拾った住所の書き方は、正解の座標を持つオープンデータで同じ書き方の住所を探し、ベンチマークに足す。
-- 使い方: duckdb -c "SET VARIABLE logs = 's3://queria-logs/geocoder/requests/**/*.parquet'; .read bench/suspicious.sql"
WITH logs AS (
  SELECT
    *,
    -- 数字の後の「ー」は長音ではなくハイフン (1ー2ー3)。結果には「-」で書かれるので、文字として数えない
    regexp_replace(replace(replace(address, 'ヶ', 'ケ'), 'ヵ', 'ケ'), '([0-9０-９])ー', '\1-', 'g') AS input,
    replace(replace(matched_address || coalesce(unmatched_address, ''), 'ヶ', 'ケ'), 'ヵ', 'ケ') AS result,
    -- 照合した住所から都道府県・郡・市区町村を除いた町字の部分。入力に無くても補って返すので比べない
    regexp_replace(
      replace(replace(matched_address, 'ヶ', 'ケ'), 'ヵ', 'ケ'),
      '^(東京都|北海道|京都府|大阪府|.{2,3}県)?(.{1,5}郡.{1,5}?[町村]|.{1,6}?市.{1,4}?区|.{1,6}?市|.{1,4}?区)?',
      ''
    ) AS town
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
        lambda ch: NOT contains(result, ch) AND NOT contains('大字小番地丁目号の之ノ条線区画', ch)
      )
    ) AS missing_chars,
    -- 丁目の漢数字 (1-2-3 は「一丁目」で返る) と、結果に付け足されることがある「町」「第◯地割」は数えない
    list_distinct(
      list_filter(
        regexp_extract_all(town, '[\p{Han}\p{Hiragana}\p{Katakana}]'),
        lambda ch: NOT contains(input, ch) AND NOT contains('一二三四五六七八九十丁目町番地号第割大字', ch)
      )
    ) AS extra_chars
  FROM logs
),
flagged AS (
  SELECT outcome, address, matched_address, unmatched_address, lg_code, candidates,
    array_to_string(missing_chars, '') AS missing,
    array_to_string(extra_chars, '') AS extra
  FROM checked
  WHERE len(missing_chars) > 0 OR len(extra_chars) > 0 OR candidates > 1
)
SELECT outcome, address, matched_address, unmatched_address, lg_code, candidates, missing, extra,
  count(*) AS requests
FROM flagged
GROUP BY outcome, address, matched_address, unmatched_address, lg_code, candidates, missing, extra
ORDER BY length(missing) + length(extra) = 0, requests DESC, address
LIMIT 500;
