-- DuckDB から Queria Geocoder を呼ぶマクロ。住所の一覧を渡すと、住所ごとに 1 行返す
-- 例: SELECT * FROM geocode(['東京都千代田区紀尾井町1-3', 'つくば市学園南3丁目28番10']);
-- 表の列から渡すときは: SET VARIABLE a = (SELECT list(address) FROM 表); SELECT * FROM geocode(getvariable('a'));
-- 10 件ずつ GET の /v1/forward/batch で送る (URL が長くなりすぎないよう 25 件より少なくする)。
-- 1 分 300 回の上限なので、1 回に渡すのは 3,000 件まで
INSTALL httpfs;
LOAD httpfs;

-- 住所の一覧を、10 件ずつの呼び出しの URL にする。渡す住所が 1 つも無いと read_json が落ちるので、
-- そのときは住所「-」を 1 つ送って、下で外す
CREATE OR REPLACE MACRO geocode_urls(a) AS list_transform(
  range(0, len(a), 10),
  i -> 'https://geocoder.queria.io/v1/forward/batch?include=ids,codes,small_area&'
    || array_to_string(list_transform(a[i + 1:i + 10], x -> 'address=' || url_encode(x)), '&')
);

CREATE OR REPLACE MACRO geocode(addresses) AS TABLE
SELECT
  item.address,
  item.results[1].matched_address,
  item.results[1].lat,
  item.results[1].lng,
  item.results[1].match_level,
  item.results[1].coordinates_level,
  item.results[1].lg_code,
  item.results[1].ids.machiaza_id AS machiaza_id,
  item.results[1].codes.postal_code AS postal_code,
  item.results[1].estat_small_area_code AS small_area_code
FROM (
  SELECT unnest(results) AS item
  FROM read_json(
    geocode_urls(coalesce(nullif(list_distinct(list_filter(addresses, a -> a IS NOT NULL)), []), ['-'])),
    columns = {results: 'STRUCT(address VARCHAR, results STRUCT(matched_address VARCHAR, lat DOUBLE, lng DOUBLE, match_level VARCHAR, coordinates_level VARCHAR, lg_code VARCHAR, ids STRUCT(machiaza_id VARCHAR), codes STRUCT(postal_code VARCHAR), estat_small_area_code VARCHAR)[])[]'}
  )
)
WHERE item.address <> '-';
