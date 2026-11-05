{{ config(materialized='table') }}

-- 国交省の街区レベル位置参照情報の点を ABR の町字に付けた表。ABR に座標の無い地番の住所で、
-- 親番 (「28番地10」の「28」) の点を返すのに使う。住居表示の地域の行 (街区符号) も残す。
-- 町字は、大字・町丁目と小字をつないだ名前で突き合わせる。位置参照情報と ABR で大字・町と小字の区切りが
-- 違っても (ABR の「新里町丁」と位置参照情報の「新里町」「丁」、ABR の「西枇杷島町」「養和」と位置参照情報の
-- 「西枇杷島町養和」) 同じ名前になる。名前は両側とも次の形にそろえる。
-- - 大字・町の頭の「大字」「字」と、小字の頭の「字」「小字」を外す (ABR は「大字頃藤」「字イサノ」と書くことがある)
-- - 1〜99 の数字を漢数字にし、「ヶ」「ヵ」を「ケ」にする (ABR の「東9条」「3丁」「16地割」「東恋ヶ窪」、
--   位置参照情報の「東九条」「三丁」「十六地割」「東恋ケ窪」)
-- そろえたことで同じ名前の町字が複数当たるときは、そろえる前の名前まで一致する町字を優先する。
-- 位置参照情報の小字が ABR に無い地番の親番の行は、大字・町の町字に付ける。
-- ジオコーダーは町字 1 つ分だけ読むので machiaza_key の順に並べる
WITH town AS (
    SELECT DISTINCT
        lg_code,
        machiaza_id,
        -- 大字・町の無い小字だけの町字 (朝倉市の「堤」) は、大字・町の名前を空にして小字の名前で突き合わせる
        {{ name_key("coalesce(regexp_replace(oaza_cho, '^大?字', ''), '') || coalesce(chome, '')") }} AS name,
        {{ name_key("regexp_replace(koaza, '^小?字', '')") }} AS koaza,
        coalesce(oaza_cho, '') || coalesce({{ chome_kanji('chome') }}, '') AS raw_name,
        koaza AS raw_koaza
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND (oaza_cho IS NOT NULL OR koaza IS NOT NULL)
),
block AS (
    -- 番号に全角の数字が混じる行がある (「２１」)。ジオコーダーは半角で引くのでそろえる
    SELECT
        lg_code,
        {{ name_key("regexp_replace(oaza_chome_name, '^大?字', '')") }} AS oaza_chome_name,
        {{ name_key("regexp_replace(koaza_name, '^小?字', '')") }} AS koaza_name,
        oaza_chome_name AS raw_name,
        koaza_name AS raw_koaza,
        translate(block_number, '０１２３４５６７８９', '0123456789') AS block_number,
        is_residential_address,
        lng,
        lat
    FROM nlftp.isj.block
    -- 同じ番号が離れた地点に分かれて入るものは、代表の 1 行だけ使う
    WHERE is_representative
),
full_name AS (
    SELECT *, name || coalesce(koaza, '') AS full_name FROM town
),
-- 大字・町丁目と小字をつないだ名前で付ける。位置参照情報の小字を ABR の大字・町の名前の一部として付けるのは、
-- 位置参照情報の大字・町が ABR に無いときだけ (「中」＋小字「島」を、ABR に「中」があるのに大字・町「中島」に付けない)
by_full_name AS (
    SELECT
        b.*,
        t.machiaza_id,
        row_number() OVER (
            PARTITION BY b.lg_code, b.oaza_chome_name, b.koaza_name, b.block_number, b.is_residential_address
            ORDER BY (t.raw_name = b.raw_name AND t.raw_koaza IS NOT DISTINCT FROM b.raw_koaza) DESC, t.machiaza_id
        ) AS rank
    FROM block b
    JOIN full_name t
        ON t.lg_code = b.lg_code
        AND t.full_name = b.oaza_chome_name || coalesce(b.koaza_name, '')
    WHERE b.koaza_name IS NULL
        OR t.koaza IS NOT NULL
        OR NOT EXISTS (
            SELECT 1 FROM town o
            WHERE o.lg_code = b.lg_code AND o.name = b.oaza_chome_name AND o.koaza IS NULL
        )
),
-- 小字が ABR に無い地番の親番の行 (ABR が大字・町だけを持つ「篠ノ井二ツ柳」に、位置参照情報が小字「大当」を
-- 付けている)。住居表示の街区符号の行は含めない (大字・町の中で番号が一意かを address_point_candidate で見ないため)
koaza_missing AS (
    SELECT b.*
    FROM block b
    WHERE b.koaza_name IS NOT NULL
        AND NOT b.is_residential_address
        AND NOT EXISTS (
            SELECT 1 FROM by_full_name f
            WHERE f.lg_code = b.lg_code
                AND f.oaza_chome_name = b.oaza_chome_name
                AND f.koaza_name = b.koaza_name
                AND f.block_number = b.block_number
                AND f.is_residential_address = b.is_residential_address
        )
),
matched AS (
    SELECT * EXCLUDE (raw_name, raw_koaza) FROM by_full_name
    UNION ALL
    -- 小字が ABR に無い行は、大字・町の町字に付ける。ただし同じ大字・町の同じ番号が別の小字にもあれば、
    -- どの小字の点か決まらないので、下の QUALIFY で使わない。大字・町の中で地番が一意かどうかは
    -- address_point_candidate が town.parcel_unique で見る
    SELECT
        b.* EXCLUDE (raw_name, raw_koaza),
        t.machiaza_id,
        row_number() OVER (
            PARTITION BY b.lg_code, b.oaza_chome_name, b.koaza_name, b.block_number, b.is_residential_address
            ORDER BY (t.raw_name = b.raw_name) DESC, t.machiaza_id
        ) AS rank
    FROM koaza_missing b
    JOIN town t
        ON t.lg_code = b.lg_code AND t.name = b.oaza_chome_name AND t.koaza IS NULL
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
-- 同じ町字・番号・種類の行は 1 行に絞る。小字の無い行があればそれを使う。
-- 小字の無い行が無く、別々の小字の行が残れば、どれか決まらないので使わない。
-- 住居表示の街区符号と地番の親番は同じ番号でも別の点なので、分けたまま残す
WINDOW w AS (
    PARTITION BY lg_code, machiaza_id, block_number, is_residential_address ORDER BY koaza_name NULLS FIRST
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
)
QUALIFY row_number() OVER w = 1
    AND (
        bool_or(koaza_name IS NULL) OVER w
        OR min(koaza_name) OVER w = max(koaza_name) OVER w
    )
ORDER BY machiaza_key, block_number
