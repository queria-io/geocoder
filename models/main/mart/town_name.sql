{{ config(materialized='table') }}

-- 市区町村名を書かない住所 (「松川町字市坂3-1」) から、その町名を持つ市区町村を引く索引。
-- 大字・町の名前 (頭の「大字」を外し、「ヶ」を「ケ」にそろえる) ごとに市区町村を 1 行ずつ並べ、その大字・町にある
-- 丁目の番号 (「5丁目」の 5) を chomes に持つ。よくある町名 (「天神」) で候補が多いとき、住所の番号の頭
-- (「天神5-9-2」の 5) の丁目を持つ市区町村に絞るのに使う。koazas はその大字・町にある小字の名前 (頭の「字」を外す)。
-- 「大字新田字羽広1928番1」のように小字まで書いた住所を、その小字を持つ市区町村に絞るのに使う。
-- ジオコーダーは住所の頭 2 文字 (name_key) で行グループを絞って読むので、その順に並べる。1 文字の町名 (「栄」) は
-- name_key もその 1 文字になる
SELECT
    left(name, 2) AS name_key,
    name,
    lg_code,
    list_sort(list_distinct(list(chome) FILTER (WHERE chome IS NOT NULL))) AS chomes,
    list_sort(list_distinct(list(koaza) FILTER (WHERE koaza IS NOT NULL AND koaza <> ''))) AS koazas
FROM (
    SELECT
        lg_code,
        replace(replace(regexp_replace(oaza_cho, '^大字', ''), 'ヶ', 'ケ'), 'ヵ', 'ケ') AS name,
        {{ chome_number('chome') }} AS chome,
        replace(replace(regexp_replace(koaza, '^字', ''), 'ヶ', 'ケ'), 'ヵ', 'ケ') AS koaza
    FROM {{ ref('town') }}
    WHERE oaza_cho IS NOT NULL
)
WHERE length(name) >= 1
GROUP BY name, lg_code
ORDER BY name_key, name, lg_code
