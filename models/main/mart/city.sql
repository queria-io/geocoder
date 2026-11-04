{{ config(materialized='table') }}

-- 市区町村 (政令市の区を含む) の名前と代表点。住所の頭から市区町村を切り出すのに使う。
-- 全国で 2,000 行ほどなので、まるごと読む。人口は、市区町村名の無い住所で候補が複数あるときの並び順に使う
WITH population AS (
    SELECT area, max(value) AS population
    FROM e_stat.census.census_small_area_age
    WHERE area_level = 'municipality' AND cat01 = '0010'
    GROUP BY area
)
SELECT
    lg_code,
    pref_code,
    pref_name,
    {{ half_width('county_name') }} AS county_name,
    {{ half_width('city_name') }} AS city_name,
    {{ half_width('ward_name') }} AS ward_name,
    ST_X(geometry) AS lng,
    ST_Y(geometry) AS lat,
    CAST(p.population AS BIGINT) AS population
FROM address_br.main.mart_city
LEFT JOIN population p ON p.area = left(lg_code, 5)
ORDER BY lg_code
