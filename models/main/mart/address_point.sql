{{ config(materialized='table') }}

-- 住所ごとの既定の点。ジオコーダーは住所の文字列をこの表のキーに直し、1 行引くだけで座標を返す。
-- 点の選び方:
--   1. その住所自身の点のうち、point_priority の rank が最も小さいもの
--   2. 無ければ近い親の番号の点から順に (「3番5号2」なら「3番5号」、次に「3番」。「28番地10」なら「28」)
--   3. それも無ければ点は NULL (ジオコーダーは町字の点を返す)
-- 地番は、自身の点も親の点も、町字そのものと地番が振られた区域の町字 (town.numbering_id) の両方で探す。
-- 同じ段・同じ rank なら町字そのものの点を先に使い、残りは座標で決めて作り直しても同じ点を選ぶ
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
-- 点を探す町字。等号で結合できるように、地番の区域の町字は別の行にする
lookup AS (
    SELECT lg_code, machiaza_id, system, num1, num2, num3, machiaza_id AS lookup_id FROM address
    UNION ALL
    SELECT lg_code, machiaza_id, system, num1, num2, num3, numbering_id
    FROM address
    WHERE system = 'parcel' AND parcel_unique AND numbering_id <> machiaza_id
),
-- step 0 は自身の点、1 は番号 2 つまでの親 (num3 のある住所だけ)、2 は番号 1 つの親
matched AS (
    SELECT
        l.lg_code,
        l.machiaza_id,
        l.system,
        l.num1,
        l.num2,
        l.num3,
        CASE
            WHEN c.num2 IS NOT DISTINCT FROM l.num2 AND c.num3 IS NOT DISTINCT FROM l.num3 THEN 0
            WHEN c.num2 IS NOT NULL THEN 1
            ELSE 2
        END AS step,
        c.point_type AS candidate_point_type,
        c.source,
        c.lng,
        c.lat,
        c.rank,
        l.lookup_id = l.machiaza_id AS same_town
    FROM lookup l
    JOIN candidate c
        ON c.lg_code = l.lg_code
        AND c.machiaza_id = l.lookup_id
        AND c.system = l.system
        AND c.num1 = l.num1
    WHERE (c.num2 IS NOT DISTINCT FROM l.num2 AND c.num3 IS NOT DISTINCT FROM l.num3)
        OR (l.num3 IS NOT NULL AND c.num2 = l.num2 AND c.num3 IS NULL)
        OR (l.num2 IS NOT NULL AND c.num2 IS NULL AND c.num3 IS NULL)
),
chosen AS (
    SELECT
        *,
        CASE
            WHEN step = 0 THEN candidate_point_type
            WHEN system = 'parcel' THEN 'parcel_parent'
            WHEN step = 2 THEN 'block'
            ELSE candidate_point_type
        END AS point_type
    FROM matched
    QUALIFY row_number() OVER (
        PARTITION BY lg_code, machiaza_id, system, num1, num2, num3
        ORDER BY step, rank, same_town DESC, lng, lat
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
