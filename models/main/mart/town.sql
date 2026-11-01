{{ config(materialized='table') }}

-- 町字ごとの名前・別名・代表点と、代表点が入る国勢調査の小地域。
-- lg_code で絞って読むので、その順に並べる
WITH town AS (
    SELECT
        *,
        -- 一部だけ住居表示を実施した町字は、同じ町字 ID に住居表示 ('1') と地番 ('0') の
        -- 2 行がある (約 1,200 組、ほかの列は同じ)。1 行にまとめ、地番の住所もあることを残す
        count(DISTINCT rsdt_addr_flg) OVER (PARTITION BY lg_code, machiaza_id) > 1 AS rsdt_addr_partial
    FROM address_br.main.mart_town
    QUALIFY row_number() OVER (
        PARTITION BY lg_code, machiaza_id ORDER BY rsdt_addr_flg DESC, efct_date DESC NULLS LAST
    ) = 1
),
-- 同じ大字・町に丁目のある行が 1 つでもあれば、その大字・町は丁目を持つ
oaza_has_chome AS (
    SELECT DISTINCT lg_code, oaza_cho FROM town WHERE chome IS NOT NULL
),
-- 町字 ID の頭 4 桁が大字・町、末尾 3 桁が丁目・小字。代表点の無い小字 (大半がそう) は、
-- 同じ大字・町 (末尾 000) の代表点を使う
located AS (
    SELECT
        t.*,
        coalesce(t.geometry, p.geometry) AS point,
        CASE
            WHEN t.geometry IS NOT NULL THEN 'town'
            WHEN p.geometry IS NOT NULL THEN 'parent_town'
        END AS point_level
    FROM town t
    LEFT JOIN town p
        ON p.lg_code = t.lg_code
        AND p.machiaza_id = left(t.machiaza_id, 4) || '000'
        AND t.geometry IS NULL
),
small_area AS (
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
    t.koaza_aka_code = '2' AS kyoto_street,
    t.machiaza_dist,
    t.chome IS NOT NULL OR t.oaza_cho LIKE '%丁目' OR h.oaza_cho IS NOT NULL AS has_chome,
    t.alias_oaza,
    t.alias_koaza,
    t.rsdt_addr_flg,
    t.rsdt_addr_partial,
    t.post_code,
    t.efct_date,
    ST_X(t.point) AS lng,
    ST_Y(t.point) AS lat,
    t.point_level,
    s.small_area_code
FROM located t
LEFT JOIN oaza_has_chome h ON h.lg_code = t.lg_code AND h.oaza_cho = t.oaza_cho
LEFT JOIN small_area s ON ST_Contains(s.geometry, t.point)
-- 境界が重なる場所では代表点が 2 つの小地域に入る。町字 1 行に 1 つだけ残す
QUALIFY row_number() OVER (PARTITION BY t.lg_code, t.machiaza_id ORDER BY s.small_area_code) = 1
ORDER BY t.lg_code, t.machiaza_id
