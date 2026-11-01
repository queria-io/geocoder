{{ config(materialized='table') }}

-- 国交省の街区レベル位置参照情報の点を ABR の町字に付けた表。ABR に座標の無い地番の住所で、
-- 親番 (「28番地10」の「28」) の点を返すのに使う。住居表示の地域の行 (街区符号) も残す。
-- 位置参照情報は「学園南三丁目」のように大字・町と丁目を 1 つの名前で持つので、ABR の町字の
-- 名前を同じ形にして突き合わせる。小字のある行は同じ小字の町字に、小字の無い行は大字・町の町字に付ける。
-- ジオコーダーは町字 1 つ分だけ読むので machiaza_key の順に並べる
WITH town AS (
    SELECT DISTINCT
        lg_code,
        machiaza_id,
        oaza_cho || coalesce({{ chome_kanji('chome') }}, '') AS name,
        koaza
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND oaza_cho IS NOT NULL
),
block AS (
    -- 番号に全角の数字が混じる行がある (「２１」)。ジオコーダーは半角で引くのでそろえる
    SELECT
        lg_code,
        oaza_chome_name,
        koaza_name,
        translate(block_number, '０１２３４５６７８９', '0123456789') AS block_number,
        is_residential_address,
        lng,
        lat
    FROM nlftp.isj.block
    -- 同じ番号が離れた地点に分かれて入るものは、代表の 1 行だけ使う
    WHERE is_representative
),
matched AS (
    SELECT
        b.*,
        t.machiaza_id,
        row_number() OVER (
            PARTITION BY b.lg_code, b.oaza_chome_name, b.koaza_name, b.block_number, b.is_residential_address
            ORDER BY t.machiaza_id
        ) AS rank
    FROM block b
    JOIN town t
        ON t.lg_code = b.lg_code
        AND t.name = b.oaza_chome_name
        -- 小字のある行は同じ小字の町字にだけ付ける。小字が ABR に無い行は捨てる (大字に付けると、
        -- 地番が小字ごとに振られた地域で別の小字の同じ番号の点を返してしまう)
        AND (t.koaza = b.koaza_name OR (t.koaza IS NULL AND b.koaza_name IS NULL))
)
SELECT
    lg_code || machiaza_id AS machiaza_key,
    lg_code,
    machiaza_id,
    block_number,
    is_residential_address,
    lng,
    lat
FROM matched
WHERE rank = 1
-- 念のため、同じ町字・番号・種類の行は 1 行に絞る
-- 住居表示の街区符号と地番の親番は同じ番号でも別の点なので、分けたまま残す
QUALIFY row_number() OVER (
    PARTITION BY machiaza_key, block_number, is_residential_address ORDER BY koaza_name NULLS FIRST
) = 1
ORDER BY machiaza_key, block_number
