{{ config(materialized='table') }}

-- 地番を引く表。ジオコーダーは町字 1 つ分だけ読むので、machiaza_key (lg_code と machiaza_id を
-- つないだもの) の順に並べ、行グループの最小・最大で絞れるようにする。
-- 地番の半角カナは、ほかの表と同じ全角にそろえる。
-- 地番の点が、町字の市区町村の境界 (国勢調査の小地域) の外にあるときは点を持たない。
-- ABR には、平面直角座標の原点の付近など、別の市区町村に置かれた点がある。
-- 境界の無い市区町村 (国勢調査の後に区を置き直した浜松市など) では、この確認をしない
WITH parcel AS (
    SELECT * FROM address_br.main.mart_parcel WHERE geometry IS NOT NULL
),
boundary AS (
    SELECT left(CAST(key_code AS VARCHAR), 5) AS city_code, geometry FROM e_stat.boundary.small_area
),
-- 点が町字の市区町村の小地域に入るか。市区町村の一致は空間結合の条件に入れない (入れると DuckDB が
-- 市区町村の一致で結合し、点ごとに市区町村の全部の小地域を調べるので遅くなる)
contained AS (
    SELECT p.lg_code, p.machiaza_id, p.prc_id, bool_or(b.city_code = left(p.lg_code, 5)) AS inside
    FROM parcel p
    JOIN boundary b ON ST_Intersects(b.geometry, p.geometry)
    GROUP BY ALL
),
-- 同じ町字と地番 ID の行が複数ある (約 6,600 組) ので、1 組 1 行にする
outside AS (
    SELECT DISTINCT p.lg_code, p.machiaza_id, p.prc_id
    FROM parcel p
    SEMI JOIN (SELECT DISTINCT city_code FROM boundary) c ON c.city_code = left(p.lg_code, 5)
    LEFT JOIN contained i USING (lg_code, machiaza_id, prc_id)
    WHERE NOT coalesce(i.inside, false)
)
SELECT
    p.lg_code || p.machiaza_id AS machiaza_key,
    p.lg_code,
    p.machiaza_id,
    p.prc_id,
    {{ full_width_katakana('p.prc_num1') }} AS prc_num1,
    {{ full_width_katakana('p.prc_num2') }} AS prc_num2,
    {{ full_width_katakana('p.prc_num3') }} AS prc_num3,
    CASE WHEN o.prc_id IS NULL THEN ST_X(p.geometry) END AS lng,
    CASE WHEN o.prc_id IS NULL THEN ST_Y(p.geometry) END AS lat
FROM address_br.main.mart_parcel p
LEFT JOIN outside o USING (lg_code, machiaza_id, prc_id)
ORDER BY machiaza_key, p.prc_id
