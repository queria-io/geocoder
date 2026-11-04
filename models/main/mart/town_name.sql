{{ config(materialized='table') }}

-- 市区町村名を書かない住所 (「松川町字市坂3-1」「天神5-9-2」) から、その住所を持つ市区町村を引く索引。
-- 町字ごとに 1 行で、大字・町の名前 (頭の「大字」を外し、「ヶ」を「ケ」にそろえる)、丁目の番号 (「5丁目」の 5)、
-- 小字の名前 (頭の「字」を外す) と、その町字にある番号を持つ。番号は住居表示の街区符号、地番の本番、
-- 位置参照情報の街区・地番の番号で、続く番号をまとめた [始め, 終わり] を順に並べる (「1〜120, 122〜300」は
-- [1, 120, 122, 300])。ジオコーダーは、住所に書かれた町名・小字・丁目・番号がどこまで実在するかで候補の市区町村を決める。
-- ジオコーダーは住所の頭 2 文字 (name_key) で行グループを絞って読むので、その順に並べる。1 文字の町名 (「栄」) は
-- name_key もその 1 文字になる
WITH town AS (
    SELECT
        lg_code,
        machiaza_id,
        replace(replace(regexp_replace(oaza_cho, '^大字', ''), 'ヶ', 'ケ'), 'ヵ', 'ケ') AS name,
        {{ chome_number('chome') }} AS chome,
        nullif(replace(replace(regexp_replace(koaza, '^字', ''), 'ヶ', 'ケ'), 'ヵ', 'ケ'), '') AS koaza
    FROM {{ ref('town') }}
    WHERE oaza_cho IS NOT NULL
),
number AS (
    SELECT DISTINCT lg_code, machiaza_id, n
    FROM (
        SELECT lg_code, machiaza_id, TRY_CAST(blk_num AS INTEGER) AS n FROM {{ ref('rsdtdsp_blk') }}
        UNION ALL
        SELECT left(machiaza_key, 6), substr(machiaza_key, 7), TRY_CAST(prc_num1 AS INTEGER) FROM {{ ref('parcel') }}
        UNION ALL
        SELECT left(machiaza_key, 6), substr(machiaza_key, 7), TRY_CAST(block_number AS INTEGER) FROM {{ ref('isj_block') }}
    )
    WHERE n IS NOT NULL
),
run AS (
    SELECT lg_code, machiaza_id, min(n) AS lo, max(n) AS hi
    FROM (
        SELECT *, n - row_number() OVER (PARTITION BY lg_code, machiaza_id ORDER BY n) AS g FROM number
    )
    GROUP BY lg_code, machiaza_id, g
),
numbers AS (
    SELECT lg_code, machiaza_id, flatten(list([lo, hi] ORDER BY lo)) AS numbers
    FROM run
    GROUP BY lg_code, machiaza_id
)
SELECT
    left(t.name, 2) AS name_key,
    t.name,
    t.lg_code,
    t.chome,
    t.koaza,
    n.numbers
FROM town t
LEFT JOIN numbers n USING (lg_code, machiaza_id)
WHERE length(t.name) >= 1
ORDER BY name_key, t.name, t.lg_code, t.chome, t.koaza
