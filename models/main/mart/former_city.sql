{{ config(materialized='table') }}

-- 合併などで無くなった市区町村の名前 (「三重県員弁郡員弁町」) から、その範囲を引き継いだ今の市区町村を引く索引。
-- 元は CODH の歴史的行政区域データセット (queria/codh)。名前は郡を付けた形 (員弁郡員弁町) と付けない形 (員弁町) の
-- 両方を並べ、別の書き方 (留辺蘂・留辺蕊) も 1 行ずつにする。今の市区町村は、旧市区町村の面積の 1 割以上が入るものを
-- 全部、入る割合 (share) とともに並べる。重なりの無いものは代表点の入る市区町村にする。
-- 今の市区町村と同じ名前 (同じ都道府県) は、上流がそのまま照合するので入れない。
-- ジオコーダーは住所の頭 2 文字 (name_key) で行グループを絞って読むので、その順に並べる
WITH former AS (
    SELECT
        m.geoshape_city_id,
        m.prefecture_code,
        m.county_or_city,
        m.suffix,
        m.current_lg_code,
        unnest(m.name_variants) AS variant
    FROM codh.city.municipality m
    WHERE NOT m.is_current
),
successor AS (
    SELECT
        f.*,
        coalesce(o.current_lg_code, f.current_lg_code) AS lg_code,
        coalesce(o.past_share, 1.0) AS share
    FROM former f
    LEFT JOIN codh.city.current_overlap o
        ON o.geoshape_city_id = f.geoshape_city_id AND o.past_share >= 0.1
),
named AS (
    SELECT
        prefecture_code,
        replace(replace(variant || suffix, 'ヶ', 'ケ'), 'ヵ', 'ケ') AS town_prefix,
        replace(replace(coalesce(county_or_city, '') || variant || suffix, 'ヶ', 'ケ'), 'ヵ', 'ケ') AS with_county,
        lg_code,
        share
    FROM successor
    WHERE lg_code IS NOT NULL
),
forms AS (
    SELECT prefecture_code, with_county AS name, town_prefix, lg_code, share FROM named
    UNION
    SELECT prefecture_code, town_prefix AS name, town_prefix, lg_code, share FROM named
),
current_names AS (
    SELECT left(lg_code, 2) AS pref_code, name
    FROM {{ ref('city') }},
        unnest([
            city_name,
            coalesce(county_name, '') || city_name,
            city_name || coalesce(ward_name, ''),
            ward_name
        ]) AS u(name)
    WHERE name IS NOT NULL AND name <> ''
),
grouped AS (
    SELECT
        left(name, 2) AS name_key,
        name,
        town_prefix,
        prefecture_code AS pref_code,
        lg_code,
        max(share) AS share
    FROM forms
    WHERE length(name) >= 2
        AND NOT EXISTS (
            SELECT 1 FROM current_names c
            WHERE c.pref_code = forms.prefecture_code AND c.name = forms.name
        )
    GROUP BY ALL
)
SELECT
    *,
    -- 都道府県名の無い住所でこの名前を使ってよいか。同じ名前が 2 つ以上の都道府県にあれば、どれか決められない
    count(DISTINCT pref_code) OVER (PARTITION BY name) = 1 AS one_pref
FROM grouped
ORDER BY name_key, name, lg_code
