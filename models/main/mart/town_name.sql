{{ config(materialized='table') }}

-- 市区町村名を書かない住所 (「松川町字市坂3-1」) から、その町名を持つ市区町村を引く索引。
-- 大字・町の名前 (頭の「大字」を外し、「ヶ」を「ケ」にそろえる) ごとに市区町村を 1 行ずつ並べる。
-- ジオコーダーは住所の頭 2 文字 (name_key) で行グループを絞って読むので、その順に並べる
SELECT DISTINCT
    left(name, 2) AS name_key,
    name,
    lg_code
FROM (
    SELECT
        lg_code,
        replace(replace(regexp_replace(oaza_cho, '^大字', ''), 'ヶ', 'ケ'), 'ヵ', 'ケ') AS name
    FROM {{ ref('town') }}
    WHERE oaza_cho IS NOT NULL
)
WHERE length(name) >= 2
ORDER BY name_key, name, lg_code
