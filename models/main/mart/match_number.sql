{{ config(materialized='table') }}

-- 照合の索引の番号。町字の表 (rsdtdsp・parcel) に無い番号の点を、区域（match_area の名前）と番号と
-- 出典ごとに 1 行持つ。町字に付いた住居表示の号・街区と地番の点は、Worker が町字の表から引く。
-- 番号を振る区域の名前で引く地番、地番の親番、位置参照情報（過去の版を含む）の街区・地番がここに入る。
-- 同じ区域と番号の行は point_priority の順（地価公示の地点で測った誤差の小さい順）に並べる。
-- 番号は「12-3」のように区切りを「-」にした形で持ち、半角カナは全角にする。
-- Worker は区域 1 つ分の行を読むので、区域の番号 (match_area の area_id) の順に並べる
-- 町字の名前と番号を振る区域の名前は match_area と同じ規則で決める (ABR の町字の行は machiaza_id を持つ)
WITH town AS (
    SELECT lg_code, machiaza_id, name, numbering_name
    FROM {{ ref('match_area') }}
    WHERE machiaza_id IS NOT NULL
),
parcel AS NOT MATERIALIZED (
    SELECT
        p.lg_code,
        p.machiaza_id,
        t.name,
        t.numbering_name,
        p.prc_num1 || coalesce('-' || p.prc_num2, '') || coalesce('-' || p.prc_num3, '') AS num,
        p.prc_num1,
        p.prc_num2,
        p.lng,
        p.lat
    FROM {{ ref('parcel') }} p
    JOIN town t USING (lg_code, machiaza_id)
),
-- 番号を振る区域で引くのは、その区域で同じ番号を持つ町字が 1 つのときだけ。
-- 起番フラグと違って小字ごとに番号を振っている所（同じ番号が複数の小字にある）では引かない。
-- 区域そのものの町字（大字・町の町字）に同じ番号の地番があるときも、どちらの点か決まらないので引かない
numbering_unique AS (
    SELECT lg_code, numbering_name, num
    FROM (
        SELECT lg_code, numbering_name, num, machiaza_id
        FROM parcel
        WHERE numbering_name IS NOT NULL
        UNION ALL
        SELECT p.lg_code, p.name, p.num, p.machiaza_id
        FROM parcel p
        SEMI JOIN (SELECT DISTINCT lg_code, numbering_name AS name FROM town WHERE numbering_name IS NOT NULL) n
            USING (lg_code, name)
    )
    GROUP BY lg_code, numbering_name, num
    HAVING min(machiaza_id) = max(machiaza_id)
),
candidate AS (
    -- 地番を、番号を振る区域の名前でも引けるようにする (ABR)
    SELECT
        p.lg_code,
        p.numbering_name AS area_name,
        p.num,
        'parcel' AS point_type,
        'abr' AS source,
        p.machiaza_id,
        p.lng,
        p.lat
    FROM parcel p
    SEMI JOIN numbering_unique u USING (lg_code, numbering_name, num)
    WHERE p.lng IS NOT NULL
    UNION ALL
    -- 地番の親番 (ABR)。枝番の地番の点の平均。address_point_candidate と同じく、
    -- 枝番の点が約 500m 以上離れて散らばる親番は使わない
    -- 同じ名前の町字が複数あるとき (京都の通り名の町字など) に、ビルドごとに町字 ID が変わらないよう min で決める
    SELECT lg_code, name, prc_num1, 'parcel_parent', 'abr', min(machiaza_id), avg(lng), avg(lat)
    FROM parcel
    WHERE lng IS NOT NULL AND prc_num2 IS NOT NULL
    GROUP BY lg_code, name, prc_num1
    HAVING max(lng) - min(lng) < 0.005 AND max(lat) - min(lat) < 0.005
    UNION ALL
    -- 街区・地番の親番 (位置参照情報)。名前は位置参照情報のまま。同じ名前と番号が離れた
    -- 複数の地点にあるときは、代表フラグの行の点。住居表示の街区符号と地番の親番は同じ番号でも
    -- 別の点なので (isj_block と同じ)、分けたまま残す
    SELECT
        lg_code,
        oaza_chome_name || coalesce(koaza_name, ''),
        {{ half_width(full_width_katakana('block_number')) }},
        CASE WHEN is_residential_address THEN 'block' ELSE 'parcel_parent' END,
        'isj',
        NULL,
        lng,
        lat
    FROM nlftp.isj.block
    WHERE lg_code IS NOT NULL
    QUALIFY row_number() OVER (
        PARTITION BY lg_code, oaza_chome_name, koaza_name, block_number, is_residential_address
        ORDER BY is_representative DESC, lat, lng
    ) = 1
    UNION ALL
    -- 今の版から消えた街区・地番 (位置参照情報の過去の版)。最後に載った版の点
    SELECT
        lg_code,
        oaza_chome_name || coalesce(koaza_name, ''),
        {{ half_width(full_width_katakana('block_number')) }},
        'history',
        'isj',
        NULL,
        lng,
        lat
    FROM nlftp.isj.block_history
    WHERE lg_code IS NOT NULL
        AND last_edition_year < (SELECT max(last_edition_year) FROM nlftp.isj.block_history)
)
-- 同じ区域と番号に出典が複数あれば、その全部を優先順に並べて持つ。Worker は先頭の行の点を使う。
-- 町字の表の点と合わせて 1 行に絞るのも Worker で行う (point_priority の rank の小さいもの)
SELECT
    a.area_id,
    c.lg_code,
    c.num,
    c.point_type,
    c.source,
    pr.rank,
    c.machiaza_id,
    c.lng,
    c.lat,
    left(c.lg_code, 2) AS pref_code
FROM candidate c
JOIN (SELECT DISTINCT area_id, lg_code, name FROM {{ ref('match_area') }}) a
    ON a.lg_code = c.lg_code AND a.name = c.area_name
JOIN {{ ref('point_priority') }} pr USING (point_type, source)
-- 優先順が同じときに、ビルドごとに並びが変わらないよう座標で決める
ORDER BY a.area_id, c.num, pr.rank, c.lat, c.lng
