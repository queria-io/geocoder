{{ config(materialized='table') }}

-- 都道府県の名前と代表点
SELECT
    lg_code,
    pref_code,
    pref_name,
    ST_X(geometry) AS lng,
    ST_Y(geometry) AS lat
FROM {{ ref('stg_address_br_pref') }}
ORDER BY lg_code
