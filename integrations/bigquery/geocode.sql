-- PROJECT・DATASET・REGION・CONNECTION・ENDPOINT を自分の値に置き換えて実行する
CREATE OR REPLACE FUNCTION `PROJECT.DATASET.geocode`(address STRING)
RETURNS JSON
REMOTE WITH CONNECTION `PROJECT.REGION.CONNECTION`
OPTIONS (endpoint = 'ENDPOINT', max_batching_rows = 100);

-- 使い方: 住所の列を渡し、JSON から列を取り出す
SELECT
  address,
  LAX_FLOAT64(g.lat) AS lat,
  LAX_FLOAT64(g.lng) AS lng,
  LAX_STRING(g.match_level) AS match_level,
  LAX_STRING(g.lg_code) AS lg_code,
  LAX_STRING(g.ids.machiaza_id) AS machiaza_id,
  LAX_STRING(g.codes.postal_code) AS postal_code,
  LAX_STRING(g.estat_small_area_code) AS small_area_code
FROM (
  SELECT address, `PROJECT.DATASET.geocode`(address) AS g
  FROM UNNEST(['東京都千代田区紀尾井町1-3', 'つくば市学園南3丁目28番10']) AS address
);
