{{ config(materialized='table') }}

-- 法務省の登記所備付地図の筆の代表点を、ABR の町字と地番の番号に付けた表。ABR に座標の無い地番の住所の点に使う。
-- 使う筆は 3 つの規則で選ぶ。
-- 1. 代表点のある筆 (公共座標系の図面の筆。任意座標系の図面の筆は位置が分からないので代表点が無い)
-- 2. 地番が数字とハイフンだけの筆 (「道-10」「筆界未定地-24」「地区外」などは使わない)
-- 3. 大字・町、丁目、小字の名前が ABR の町字と完全に一致し、町字が 1 つに決まる筆
-- 同じ町字・地番の筆が複数ある (図面をまたぐ) ときは、どの点か決まらないので使わない。
-- ABR に同じ地番の点がある筆は、同じ点なので入れない (ABR の地番の点は登記所備付地図から作られている)
WITH town AS (
    SELECT lg_code, machiaza_id, oaza_cho, chome, koaza
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND oaza_cho IS NOT NULL
    QUALIFY count(*) OVER (PARTITION BY lg_code, oaza_cho, chome, koaza) = 1
),
fude AS (
    SELECT
        t.lg_code,
        t.machiaza_id,
        split_part(f.chiban, '-', 1) AS prc_num1,
        nullif(split_part(f.chiban, '-', 2), '') AS prc_num2,
        nullif(split_part(f.chiban, '-', 3), '') AS prc_num3,
        f.lng,
        f.lat
    FROM moj.chizu.parcel f
    JOIN town t
        ON t.lg_code = f.lg_code
        AND t.oaza_cho = f.oaza
        AND t.chome IS NOT DISTINCT FROM f.chome
        AND t.koaza IS NOT DISTINCT FROM f.koaza
    WHERE f.lng IS NOT NULL AND regexp_matches(f.chiban, '^[0-9]+(-[0-9]+){0,2}$')
)
SELECT
    f.lg_code || f.machiaza_id AS machiaza_key,
    f.lg_code,
    f.machiaza_id,
    f.prc_num1,
    f.prc_num2,
    f.prc_num3,
    any_value(f.lng) AS lng,
    any_value(f.lat) AS lat
FROM fude f
ANTI JOIN {{ ref('parcel') }} p
    ON p.lg_code = f.lg_code
    AND p.machiaza_id = f.machiaza_id
    AND p.prc_num1 = f.prc_num1
    AND p.prc_num2 IS NOT DISTINCT FROM f.prc_num2
    AND p.prc_num3 IS NOT DISTINCT FROM f.prc_num3
    AND p.lng IS NOT NULL
GROUP BY ALL
HAVING count(*) = 1
ORDER BY machiaza_key, prc_num1, prc_num2 NULLS FIRST, prc_num3 NULLS FIRST
