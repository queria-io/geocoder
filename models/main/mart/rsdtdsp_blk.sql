{{ config(materialized='table') }}

-- 住居表示の街区（「○番」）の代表点。座標は数値の列で持つ (geometry より読む量が小さい)
SELECT
    lg_code,
    machiaza_id,
    blk_id,
    blk_num,
    ST_X(geometry) AS lng,
    ST_Y(geometry) AS lat
FROM address_br.main.mart_rsdtdsp_blk
ORDER BY lg_code, machiaza_id, blk_id
