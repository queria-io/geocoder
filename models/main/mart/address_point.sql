{{ config(materialized='table') }}

-- 住所ごとの既定の点。ジオコーダーは住所の文字列をこの表のキーに直し、1 行引くだけで座標を返す。
-- 点の選び方:
--   1. その住所自身の点のうち、point_priority の rank が最も小さいもの
--   2. 無ければ親の番号 (「28番地10」なら「28」、「3番5号」なら「3番」) の点。
--      地番は、町字そのものと地番が振られた区域の町字 (town.numbering_id) の両方で探す
--   3. それも無ければ点は NULL (ジオコーダーは町字の点を返す)
-- ジオコーダーは町字 1 つ分だけ読むので、machiaza_key の順に並べる
WITH candidate AS (
    SELECT c.*, p.rank
    FROM {{ ref('address_point_candidate') }} c
    JOIN {{ ref('point_priority') }} p USING (point_type, source)
    WHERE c.lng IS NOT NULL
),
address AS (
    SELECT DISTINCT a.lg_code, a.machiaza_id, a.system, a.num1, a.num2, a.num3, t.numbering_id, t.parcel_unique
    FROM {{ ref('address_point_candidate') }} a
    JOIN {{ ref('town') }} t USING (lg_code, machiaza_id)
),
own AS (
    SELECT a.*, c.point_type, c.source, c.lng, c.lat, c.rank, 0 AS step
    FROM address a
    JOIN candidate c
        ON c.lg_code = a.lg_code
        AND c.machiaza_id = a.machiaza_id
        AND c.system = a.system
        AND c.num1 = a.num1
        AND c.num2 IS NOT DISTINCT FROM a.num2
        AND c.num3 IS NOT DISTINCT FROM a.num3
),
parent AS (
    SELECT
        a.*,
        CASE WHEN a.system = 'parcel' THEN 'parcel_parent' ELSE 'block' END AS point_type,
        c.source,
        c.lng,
        c.lat,
        c.rank,
        1 AS step
    FROM address a
    JOIN candidate c
        ON c.lg_code = a.lg_code
        AND c.system = a.system
        AND c.num1 = a.num1
        AND c.num2 IS NULL
        AND c.num3 IS NULL
        AND (
            c.machiaza_id = a.machiaza_id
            OR (a.system = 'parcel' AND a.parcel_unique AND c.machiaza_id = a.numbering_id)
        )
    WHERE a.num2 IS NOT NULL
),
chosen AS (
    SELECT * FROM (SELECT * FROM own UNION ALL SELECT * FROM parent)
    QUALIFY row_number() OVER (
        PARTITION BY lg_code, machiaza_id, system, num1, num2, num3 ORDER BY step, rank
    ) = 1
)
SELECT
    a.lg_code || a.machiaza_id AS machiaza_key,
    a.lg_code,
    a.machiaza_id,
    a.system,
    a.num1,
    a.num2,
    a.num3,
    c.point_type,
    c.source,
    p.error_m,
    c.lng,
    c.lat
FROM address a
LEFT JOIN chosen c
    ON c.lg_code = a.lg_code
    AND c.machiaza_id = a.machiaza_id
    AND c.system = a.system
    AND c.num1 = a.num1
    AND c.num2 IS NOT DISTINCT FROM a.num2
    AND c.num3 IS NOT DISTINCT FROM a.num3
LEFT JOIN {{ ref('point_priority') }} p ON p.point_type = c.point_type AND p.source = c.source
ORDER BY machiaza_key, a.system, a.num1, a.num2 NULLS FIRST, a.num3 NULLS FIRST
