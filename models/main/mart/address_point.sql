{{ config(materialized='table') }}

-- 住所ごとの既定の点。同じ住所に出どころの違う点があれば、point_priority の rank が最も小さいものを選ぶ。
-- 同じ rank なら座標で決めて、作り直しても同じ点を選ぶ。
-- 点の無い住所の親の番号 (「28番地10」なら「28」) や、地番が振られた区域の町字 (town.numbering_id) は
-- ジオコーダーが引くときにたどる。ここで全住所に広げると、地番 2 億行を突き合わせることになり Sync のメモリに収まらない。
-- ジオコーダーは町字 1 つ分だけ読むので、machiaza_key の順に並べる
SELECT
    c.lg_code || c.machiaza_id AS machiaza_key,
    c.lg_code,
    c.machiaza_id,
    c.system,
    c.num1,
    c.num2,
    c.num3,
    c.point_type,
    c.source,
    p.error_m,
    c.lng,
    c.lat
FROM {{ ref('address_point_candidate') }} c
JOIN {{ ref('point_priority') }} p USING (point_type, source)
QUALIFY row_number() OVER (
    PARTITION BY c.lg_code, c.machiaza_id, c.system, c.num1, c.num2, c.num3
    ORDER BY p.rank, c.lng, c.lat
) = 1
ORDER BY machiaza_key, c.system, c.num1, c.num2 NULLS FIRST, c.num3 NULLS FIRST
