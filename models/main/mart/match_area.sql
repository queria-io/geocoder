{{ config(materialized='table') }}

-- 照合の索引の区域。住所の名前の部分（大字・町、丁目、小字）を、出典の名前のまま 1 行ずつ持つ。
-- Worker は市区町村 1 つ分の行を読み、住所と同じ正規化を名前に当てて最長一致で引く。
-- 番号は match_number を区域の番号 (area_id) で引く。区域の点は、番号まで読めなかったときに返す点
WITH town AS (
    SELECT * FROM {{ ref('town') }} WHERE oaza_cho IS NOT NULL
),
abr AS (
    -- 京都の通り名の町字は、小字の欄に通り名を書く。区域の名前には入れない
    SELECT
        lg_code,
        machiaza_id,
        oaza_cho || coalesce(chome, '') || CASE WHEN kyoto_street THEN '' ELSE coalesce(koaza, '') END AS name,
        -- 起番でない小字の地番は、大字・町（丁目まで）の区域で振られている
        CASE
            WHEN koaza IS NOT NULL AND NOT kyoto_street AND wake_num_flg <> '1'
            THEN oaza_cho || coalesce(chome, '')
        END AS numbering_name,
        point_level = 'town' AS own_point,
        lng,
        lat
    FROM town
),
-- 丁目に分かれた大字・町は、丁目を省いた名前 (「学園南」) も区域にする。町字 ID は大字・町の頭 4 桁に 000 を付けたもの、
-- 点は丁目の町字の点の平均。ABR に大字・町そのものの行があれば、そちらを使う。
-- 同じ市区町村に同じ名前の大字・町が 2 つ以上あれば、どちらか決まらないので区域にしない
oaza AS (
    SELECT
        lg_code,
        min(left(machiaza_id, 4)) || '000' AS machiaza_id,
        oaza_cho AS name,
        NULL AS numbering_name,
        false AS own_point,
        avg(lng) AS lng,
        avg(lat) AS lat
    FROM town
    WHERE chome IS NOT NULL
    GROUP BY lg_code, oaza_cho
    HAVING count(DISTINCT left(machiaza_id, 4)) = 1
),
-- ABR に町字の行が無い大字・町（丁目まで）も区域にする。点はその下の町字の点の平均
parent AS (
    SELECT
        lg_code,
        NULL AS machiaza_id,
        oaza_cho || coalesce(chome, '') AS name,
        NULL AS numbering_name,
        false AS own_point,
        avg(lng) AS lng,
        avg(lat) AS lat
    FROM town
    WHERE koaza IS NOT NULL AND NOT kyoto_street
    GROUP BY lg_code, oaza_cho || coalesce(chome, '')
),
-- 位置参照情報（過去の版を含む）にだけある名前も区域にする。点は持たず、番号の点だけを引く
isj AS (
    SELECT DISTINCT lg_code, oaza_chome_name || coalesce(koaza_name, '') AS name
    FROM nlftp.isj.block
    WHERE lg_code IS NOT NULL
    UNION
    SELECT DISTINCT lg_code, oaza_chome_name || coalesce(koaza_name, '') AS name
    FROM nlftp.isj.block_history
    WHERE lg_code IS NOT NULL
)
-- area_id は区域の名前ごとの番号。match_number はこの番号で区域を指す (名前の文字列より並べ替えが軽い)
SELECT dense_rank() OVER (ORDER BY lg_code, name) AS area_id, *, left(lg_code, 2) AS pref_code FROM (
    SELECT * FROM abr
    UNION ALL
    SELECT o.* FROM oaza o ANTI JOIN abr a USING (lg_code, name)
    UNION ALL
    SELECT p.* FROM parent p ANTI JOIN abr a USING (lg_code, name) ANTI JOIN oaza o USING (lg_code, name)
    UNION ALL
    SELECT i.lg_code, NULL, i.name, NULL, false, NULL, NULL
    FROM isj i
    ANTI JOIN abr a USING (lg_code, name)
    ANTI JOIN parent p USING (lg_code, name)
    ANTI JOIN oaza o USING (lg_code, name)
)
ORDER BY lg_code, name, machiaza_id
