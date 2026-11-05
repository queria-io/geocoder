{{ config(materialized='table') }}

-- 地番を引く表。ジオコーダーは町字 1 つ分だけ読むので、machiaza_key (lg_code と machiaza_id を
-- つないだもの) の順に並べ、行グループの最小・最大で絞れるようにする。
-- 地番の半角カナは、ほかの表と同じ全角にそろえる。
-- 地番の点が、その町字 (代表点が無ければ同じ大字・町) の代表点と別の市区町村の小地域に入っているときは、
-- 点を使わない (NULL にする)。ABR には、小字の地番の点がまとめて別の市区町村に入っているものがある
-- (永平寺町の「山王6字」などが約 30km 離れた所にある)。市区町村は国勢調査の小地域の KEY_CODE の頭 5 桁で
-- 比べるので、国勢調査のあとに市区町村コードが変わった所 (浜松市の区) でも両側が同じコードで比べられる
WITH small_area AS (
    SELECT left(CAST(key_code AS VARCHAR), 5) AS city, geometry FROM e_stat.boundary.small_area
),
town AS (
    SELECT lg_code, machiaza_id, geometry
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND geometry IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY lg_code, machiaza_id ORDER BY rsdt_addr_flg DESC) = 1
),
town_city AS (
    SELECT t.lg_code, t.machiaza_id, any_value(s.city) AS city
    FROM town t
    JOIN small_area s ON ST_Intersects(s.geometry, t.geometry)
    GROUP BY ALL
),
parcel_city AS (
    SELECT p.lg_code, p.machiaza_id, p.prc_id, any_value(s.city) AS city
    FROM address_br.main.mart_parcel p
    JOIN small_area s ON ST_Intersects(s.geometry, p.geometry)
    GROUP BY ALL
),
misplaced AS (
    SELECT c.lg_code, c.machiaza_id, c.prc_id
    FROM parcel_city c
    LEFT JOIN town_city t ON t.lg_code = c.lg_code AND t.machiaza_id = c.machiaza_id
    LEFT JOIN town_city o ON o.lg_code = c.lg_code AND o.machiaza_id = left(c.machiaza_id, 4) || '000'
    WHERE coalesce(t.city, o.city) <> c.city
)
SELECT
    p.lg_code || p.machiaza_id AS machiaza_key,
    p.lg_code,
    p.machiaza_id,
    p.prc_id,
    {{ full_width_katakana('p.prc_num1') }} AS prc_num1,
    {{ full_width_katakana('p.prc_num2') }} AS prc_num2,
    {{ full_width_katakana('p.prc_num3') }} AS prc_num3,
    CASE WHEN m.prc_id IS NULL THEN ST_X(p.geometry) END AS lng,
    CASE WHEN m.prc_id IS NULL THEN ST_Y(p.geometry) END AS lat
FROM address_br.main.mart_parcel p
LEFT JOIN misplaced m ON m.lg_code = p.lg_code AND m.machiaza_id = p.machiaza_id AND m.prc_id = p.prc_id
ORDER BY machiaza_key, p.prc_id
