-- DuckDB から Queria Geocoder を呼ぶマクロ。住所の一覧を渡すと、住所ごとに 1 行返す
-- 例: SELECT * FROM geocode(['東京都千代田区紀尾井町1-3', 'つくば市学園南3丁目28番10']);
-- 表の列から渡すときは: SET VARIABLE a = (SELECT list(address) FROM 表); SELECT * FROM geocode(getvariable('a'));
-- 1 住所 1 回の呼び出しなので、1 回に渡すのは 300 件まで (1 分 300 回の上限)
INSTALL httpfs;
LOAD httpfs;

CREATE OR REPLACE MACRO geocode(addresses) AS TABLE
SELECT
  url_decode(regexp_extract(filename, '[?&]address=([^&]*)', 1)) AS address,
  r.matched_address, r.lat, r.lng, r.match_level, r.coordinates_level, r.lg_code,
  r.ids.machiaza_id AS machiaza_id,
  r.codes.postal_code AS postal_code,
  r.estat_small_area_code AS small_area_code
FROM (
  SELECT filename, results[1] AS r
  FROM read_json(
    -- 渡す住所が 1 つも無いと read_json が落ちるので、そのときは当たらない住所「-」を 1 つ送って、下で外す
    list_transform(
      coalesce(
        -- API は空白・見えない文字だけの住所に 400 を返し、1 つでも 400 が返ると全体が落ちるので、ここで外す
        nullif(list_distinct(list_filter(addresses, a ->
          length(regexp_replace(a, '[\s\x{0B}\x{85}\x{A0}\x{AD}\x{1680}\x{2000}-\x{200F}\x{2028}-\x{202F}\x{205F}-\x{206F}\x{3000}\x{FEFF}]', '', 'g')) > 0
          AND length(trim(a)) <= 100
        )), []),
        ['-']
      ),
      a -> 'https://geocoder.queria.io/v1/forward?include=ids,codes,small_area&address=' || url_encode(a)
    ),
    filename = true,
    columns = {results: 'STRUCT(matched_address VARCHAR, lat DOUBLE, lng DOUBLE, match_level VARCHAR, coordinates_level VARCHAR, lg_code VARCHAR, ids STRUCT(machiaza_id VARCHAR), codes STRUCT(postal_code VARCHAR), estat_small_area_code VARCHAR)[]'}
  )
)
WHERE address <> '-';
