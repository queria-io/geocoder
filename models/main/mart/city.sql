{{ config(materialized='table') }}

-- 市区町村 (政令市の区を含む) の名前と代表点。住所の頭から市区町村を切り出すのに使う。
-- 全国で 2,000 行ほどなので、まるごと読む
SELECT
    lg_code,
    pref_code,
    pref_name,
    county_name,
    city_name,
    ward_name,
    ST_X(geometry) AS lng,
    ST_Y(geometry) AS lat
FROM address_br.main.mart_city
ORDER BY lg_code
