{{ config(materialized='table') }}

-- 町字ごとの名前・別名・代表点と、代表点が入る国勢調査の小地域。
-- lg_code で絞って読むので、その順に並べる
WITH town AS (
    SELECT
        *,
        -- 一部だけ住居表示を実施した町字は、同じ町字 ID に住居表示 ('1') と地番 ('0') の
        -- 2 行がある (約 1,200 組、ほかの列は同じ)。1 行にまとめ、地番の住所もあることを残す
        count(DISTINCT rsdt_addr_flg) OVER (PARTITION BY lg_code, machiaza_id) > 1 AS rsdt_addr_partial,
        -- 位置参照情報の大字・町丁目と突き合わせる名前 (頭の「大字」を外し、丁目は「三丁目」)。
        -- 頭の「大字」は ABR と位置参照情報のどちらにも、書く所と書かない所があるので両方で外す
        regexp_replace(oaza_cho, '^大字', '') || coalesce({{ chome_kanji('chome') }}, '') AS isj_name
    FROM address_br.main.mart_town
    -- 状態フラグ 3 は存在しない町字
    WHERE status_flg <> '3'
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
-- 大字・町の行に代表点が無い (または行が無い) ときは、同じ大字・町の小字などの代表点の平均を使う
oaza_mean AS (
    SELECT
        lg_code,
        left(machiaza_id, 4) AS oaza_id,
        ST_Point(avg(ST_X(geometry)), avg(ST_Y(geometry))) AS geometry
    FROM town
    WHERE geometry IS NOT NULL
    GROUP BY lg_code, left(machiaza_id, 4)
),
-- 大字・町にも小字にも代表点が無いときは、位置参照情報の大字・町丁目の点を名前で当てる。
-- 同じ市区町村に同じ名前が 2 つ以上あるものは、どちらか決まらないので使わない
isj_oaza AS (
    SELECT
        lg_code,
        regexp_replace(oaza_chome_name, '^大字', '') AS name,
        ST_Point(any_value(lng), any_value(lat)) AS geometry
    FROM nlftp.isj.oaza
    GROUP BY lg_code, regexp_replace(oaza_chome_name, '^大字', '')
    HAVING count(*) = 1
),
located AS (
    SELECT
        t.*,
        coalesce(t.geometry, p.geometry, m.geometry, i.geometry) AS point,
        CASE
            WHEN t.geometry IS NOT NULL THEN 'town'
            WHEN p.geometry IS NOT NULL THEN 'parent_town'
            WHEN m.geometry IS NOT NULL THEN 'oaza_mean'
            WHEN i.geometry IS NOT NULL THEN 'isj_oaza'
        END AS point_level
    FROM town t
    LEFT JOIN town p
        ON p.lg_code = t.lg_code
        AND p.machiaza_id = left(t.machiaza_id, 4) || '000'
        AND t.geometry IS NULL
    LEFT JOIN oaza_mean m
        ON m.lg_code = t.lg_code
        AND m.oaza_id = left(t.machiaza_id, 4)
        AND t.geometry IS NULL
    LEFT JOIN isj_oaza i
        ON i.lg_code = t.lg_code
        AND i.name = t.isj_name
        AND t.geometry IS NULL
),
-- 住居表示の住所の数。番・号の段は、これが 0 の町字では住居表示の表を読まない
rsdtdsp_count AS (
    SELECT lg_code, machiaza_id, count(*) AS rsdtdsp_count
    FROM {{ ref('rsdtdsp') }}
    GROUP BY lg_code, machiaza_id
),
-- 地番の数。地番の段は、これが 0 の町字では地番の表を読まない
parcel_count AS (
    SELECT lg_code, machiaza_id, count(*) AS parcel_count
    FROM {{ ref('parcel') }}
    GROUP BY lg_code, machiaza_id
),
-- 地番が振られる区域 (起番フラグ 1) が小字の大字・町。小字を省いた地番の住所は、この大字では
-- どの小字の地番か決まらない
koaza_numbered AS (
    SELECT DISTINCT lg_code, left(machiaza_id, 4) AS oaza_id
    FROM town
    WHERE koaza IS NOT NULL AND wake_num_flg = '1'
),
-- 地番を探す区域の町字。小字が起番でなければ地番は大字・町で振られているので、大字・町の町字 ID にする。
-- 地番の点の表は、町字そのものと、この区域の町字の両方で引く
numbering AS (
    SELECT
        t.lg_code,
        t.machiaza_id,
        CASE
            WHEN t.koaza IS NOT NULL AND t.wake_num_flg <> '1' AND p.machiaza_id IS NOT NULL THEN p.machiaza_id
            ELSE t.machiaza_id
        END AS numbering_id
    FROM town t
    LEFT JOIN town p
        ON p.lg_code = t.lg_code
        AND p.machiaza_id = left(t.machiaza_id, 4) || '000'
        AND t.koaza IS NOT NULL
),
-- 区域の町字の中で地番が一意か。起番の小字か、起番の小字を持たない大字・町なら一意。
-- 大字・町と小字の両方が起番の所 (柏市藤心など) は、大字・町の番号が小字の番号と重なりうるので一意としない
numbering_area AS (
    SELECT
        n.lg_code,
        n.machiaza_id,
        n.numbering_id,
        (a.koaza IS NOT NULL AND a.wake_num_flg = '1') OR k.oaza_id IS NULL AS parcel_unique
    FROM numbering n
    JOIN town a ON a.lg_code = n.lg_code AND a.machiaza_id = n.numbering_id
    LEFT JOIN koaza_numbered k ON k.lg_code = n.lg_code AND k.oaza_id = left(n.numbering_id, 4)
),
small_area AS (
    SELECT CAST(key_code AS VARCHAR) AS small_area_code, geometry FROM e_stat.boundary.small_area
),
-- ABR の町字マスタは多くの町字で郵便番号が空なので、japan_address_code の町字と郵便番号の対応で補う。
-- 町域名が一致したもの (name)、町域が細分されていて全部同じ番号のもの (sub)、ABR の番号 (abr) だけを使い、
-- 町字 1 つに番号が 1 つに決まるものに限る。町域名の前方一致 (prefix) と市区町村全体の番号 (city) は使わない
postal AS (
    SELECT lg_code, machiaza_id, any_value(zipcode) AS post_code
    FROM japan_address_code.main.town_postal_code
    WHERE match_type IN ('abr', 'name', 'sub')
    GROUP BY lg_code, machiaza_id
    HAVING count(DISTINCT zipcode) = 1
)
SELECT
    t.lg_code,
    t.machiaza_id,
    t.machiaza_type,
    t.pref_name,
    {{ half_width('t.county_name') }} AS county_name,
    {{ half_width('t.city_name') }} AS city_name,
    {{ half_width('t.ward_name') }} AS ward_name,
    {{ half_width('t.oaza_cho') }} AS oaza_cho,
    {{ half_width('t.chome') }} AS chome,
    {{ half_width('t.koaza') }} AS koaza,
    t.koaza_aka_code = '2' AS kyoto_street,
    {{ half_width('t.machiaza_dist') }} AS machiaza_dist,
    t.chome IS NOT NULL OR t.oaza_cho LIKE '%丁目' OR h.oaza_cho IS NOT NULL AS has_chome,
    coalesce(c.rsdtdsp_count, 0)::INTEGER AS rsdtdsp_count,
    coalesce(pc.parcel_count, 0)::INTEGER AS parcel_count,
    t.alias_oaza,
    t.alias_koaza,
    t.rsdt_addr_flg,
    t.rsdt_addr_partial,
    t.wake_num_flg,
    na.numbering_id,
    na.parcel_unique,
    coalesce(t.post_code, z.post_code) AS post_code,
    t.efct_date,
    ST_X(t.point) AS lng,
    ST_Y(t.point) AS lat,
    t.point_level,
    s.small_area_code
FROM located t
LEFT JOIN oaza_has_chome h ON h.lg_code = t.lg_code AND h.oaza_cho = t.oaza_cho
LEFT JOIN rsdtdsp_count c ON c.lg_code = t.lg_code AND c.machiaza_id = t.machiaza_id
LEFT JOIN parcel_count pc ON pc.lg_code = t.lg_code AND pc.machiaza_id = t.machiaza_id
LEFT JOIN numbering_area na ON na.lg_code = t.lg_code AND na.machiaza_id = t.machiaza_id
LEFT JOIN postal z ON z.lg_code = t.lg_code AND z.machiaza_id = t.machiaza_id
LEFT JOIN small_area s ON ST_Contains(s.geometry, t.point)
-- 境界が重なる場所では代表点が 2 つの小地域に入る。町字 1 行に 1 つだけ残す
QUALIFY row_number() OVER (PARTITION BY t.lg_code, t.machiaza_id ORDER BY s.small_area_code) = 1
ORDER BY t.lg_code, t.machiaza_id
