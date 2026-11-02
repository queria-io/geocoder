{{ config(materialized='table') }}

-- 住所ごとの点の候補。出どころごとに 1 行。住所は町字・住所の仕組み (rsdt は住居表示、parcel は地番)・
-- 番号 3 つで決まる。既定の点は address_point で選ぶ
WITH town AS (
    SELECT lg_code, machiaza_id, koaza, wake_num_flg, numbering_id, parcel_unique FROM {{ ref('town') }}
),
-- 小字ごとに地番を振った大字・町でも、ABR が大字・町の町字に直接付けている地番の番号は大字・町で一意。
-- ただし同じ大字・町の起番の小字にも同じ番号があれば、どちらか決まらないので使わない
oaza_parcel AS (
    SELECT DISTINCT p.lg_code, p.machiaza_id, p.prc_num1
    FROM {{ ref('parcel') }} p
    JOIN town t USING (lg_code, machiaza_id)
    WHERE NOT t.parcel_unique AND t.koaza IS NULL
),
koaza_parcel AS (
    SELECT DISTINCT p.lg_code, left(p.machiaza_id, 4) || '000' AS oaza_id, p.prc_num1
    FROM {{ ref('parcel') }} p
    JOIN town t USING (lg_code, machiaza_id)
    WHERE t.koaza IS NOT NULL AND t.wake_num_flg = '1'
)
SELECT * FROM (
    -- 住居表示の号と街区 (アドレス・ベース・レジストリ)
    SELECT
        lg_code,
        machiaza_id,
        'rsdt' AS system,
        blk_num AS num1,
        rsdt_num AS num2,
        rsdt_num2 AS num3,
        CASE WHEN rsdt_id IS NULL THEN 'block' ELSE 'rsdt' END AS point_type,
        'abr' AS source,
        lng,
        lat
    FROM {{ ref('rsdtdsp') }}
    UNION ALL
    -- 地番 (アドレス・ベース・レジストリ)。座標の無い筆も、住所があることを残すために入れる
    SELECT lg_code, machiaza_id, 'parcel', prc_num1, prc_num2, prc_num3, 'parcel', 'abr', lng, lat
    FROM {{ ref('parcel') }}
    UNION ALL
    -- 住居表示の街区 (街区レベル位置参照情報)
    SELECT lg_code, machiaza_id, 'rsdt', block_number, NULL, NULL, 'block', 'isj', lng, lat
    FROM {{ ref('isj_block') }}
    WHERE is_residential_address
    UNION ALL
    -- 地番の親番 (街区レベル位置参照情報)。地番が振られた区域の町字に付け直す。
    -- 小字ごとに地番を振った大字・町に付いた点は、その番号が大字・町に直接付いた地番にだけあるときに使う
    SELECT b.lg_code, t.numbering_id, 'parcel', b.block_number, NULL, NULL, 'parcel_parent', 'isj', b.lng, b.lat
    FROM {{ ref('isj_block') }} b
    JOIN town t USING (lg_code, machiaza_id)
    LEFT JOIN oaza_parcel o
        ON o.lg_code = b.lg_code AND o.machiaza_id = b.machiaza_id AND o.prc_num1 = b.block_number
    LEFT JOIN koaza_parcel k
        ON k.lg_code = b.lg_code AND k.oaza_id = b.machiaza_id AND k.prc_num1 = b.block_number
    WHERE NOT b.is_residential_address
        AND (t.parcel_unique OR (o.prc_num1 IS NOT NULL AND k.prc_num1 IS NULL))
)
ORDER BY lg_code, machiaza_id, system, num1, num2 NULLS FIRST, num3 NULLS FIRST
