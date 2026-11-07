{{ config(materialized='table') }}

-- 住居表示の住所を引く表。街区だけの行 (「○番」) と、街区と住居の行 (「○番○号」) を 1 つにする。
-- 住居表示を実施した町字の分だけ。ジオコーダーは町字 1 つ分だけ読むので、
-- machiaza_key (lg_code と machiaza_id をつないだもの) の順に並べ、行グループの最小・最大で絞れるようにする
WITH town AS (
    SELECT DISTINCT lg_code, machiaza_id
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND rsdt_addr_flg = '1'
)
SELECT *, left(lg_code, 2) AS pref_code FROM (
    SELECT
        b.lg_code || b.machiaza_id AS machiaza_key,
        b.lg_code,
        b.machiaza_id,
        b.blk_id,
        NULL::VARCHAR AS rsdt_id,
        NULL::VARCHAR AS rsdt2_id,
        b.blk_num,
        NULL::VARCHAR AS rsdt_num,
        NULL::VARCHAR AS rsdt_num2,
        b.lng,
        b.lat
    FROM {{ ref('rsdtdsp_blk') }} b
    JOIN town t USING (lg_code, machiaza_id)
    UNION ALL
    SELECT
        r.lg_code || r.machiaza_id AS machiaza_key,
        r.lg_code,
        r.machiaza_id,
        r.blk_id,
        r.rsdt_id,
        r.rsdt2_id,
        b.blk_num,
        r.rsdt_num,
        r.rsdt_num2,
        r.lng,
        r.lat
    FROM {{ ref('rsdtdsp_rsdt') }} r
    JOIN {{ ref('rsdtdsp_blk') }} b USING (lg_code, machiaza_id, blk_id)
    JOIN town t USING (lg_code, machiaza_id)
)
ORDER BY machiaza_key, blk_id, rsdt_id NULLS FIRST, rsdt2_id NULLS FIRST
