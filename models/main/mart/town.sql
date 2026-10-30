{{ config(materialized='table') }}

-- 町字ごとの名前・別名・代表点と、代表点が入る国勢調査の小地域。
-- lg_code で絞って読むので、その順に並べる
WITH small_area AS (
    SELECT CAST(key_code AS VARCHAR) AS small_area_code, geometry FROM e_stat.boundary.small_area
)
SELECT
    t.lg_code,
    t.machiaza_id,
    t.machiaza_type,
    t.pref_name,
    t.county_name,
    t.city_name,
    t.ward_name,
    t.oaza_cho,
    t.chome,
    t.koaza,
    t.alias_oaza,
    t.alias_koaza,
    t.rsdt_addr_flg,
    t.post_code,
    t.efct_date,
    ST_X(t.geometry) AS lng,
    ST_Y(t.geometry) AS lat,
    s.small_area_code
FROM address_br.main.mart_town t
LEFT JOIN small_area s ON ST_Contains(s.geometry, t.geometry)
-- 境界が重なる場所では代表点が 2 つの小地域に入る。町字 1 行に 1 つだけ残す
QUALIFY row_number() OVER (PARTITION BY t.lg_code, t.machiaza_id ORDER BY s.small_area_code) = 1
ORDER BY t.lg_code, t.machiaza_id
