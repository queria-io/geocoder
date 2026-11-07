{{ config(materialized='table') }}

-- 地番を引く表。ジオコーダーは町字 1 つ分だけ読むので、machiaza_key (lg_code と machiaza_id を
-- つないだもの) の順に並べ、行グループの最小・最大で絞れるようにする。
-- 地番の半角カナは、ほかの表と同じ全角にそろえる
SELECT
    p.lg_code || p.machiaza_id AS machiaza_key,
    p.lg_code,
    p.machiaza_id,
    p.prc_id,
    {{ full_width_katakana('p.prc_num1') }} AS prc_num1,
    {{ full_width_katakana('p.prc_num2') }} AS prc_num2,
    {{ full_width_katakana('p.prc_num3') }} AS prc_num3,
    ST_X(p.geometry) AS lng,
    ST_Y(p.geometry) AS lat,
    left(p.lg_code, 2) AS pref_code
FROM address_br.main.mart_parcel p
ORDER BY machiaza_key, p.prc_id
