{{ config(materialized='table') }}

-- 国交省の街区レベル位置参照情報の点を ABR の町字に付けた表。ABR に座標の無い地番の住所で、
-- 親番 (「28番地10」の「28」) の点を返すのに使う。住居表示の地域の行 (街区符号) も残す。
-- 位置参照情報は「学園南三丁目」のように大字・町と丁目を 1 つの名前で持つので、ABR の町字の
-- 名前を同じ形にして突き合わせる。小字のある行は同じ小字の町字に、小字の無い行と ABR に無い小字の行は大字・町の町字に付ける。
-- ABR は「大字頃藤」「字イサノ」のように頭に「大字」「字」を付けることがあり、位置参照情報は付けないので、
-- 両側とも、大字・町の名前は頭の「大字」「字」を、小字の名前は頭の「字」「小字」を外して照合する。
-- 外したことで同じ名前の町字が複数当たるときは、外す前の名前まで一致する町字を優先する
-- ジオコーダーは町字 1 つ分だけ読むので machiaza_key の順に並べる
WITH town AS (
    SELECT DISTINCT
        lg_code,
        machiaza_id,
        regexp_replace(oaza_cho, '^大?字', '') || coalesce({{ chome_kanji('chome') }}, '') AS name,
        regexp_replace(koaza, '^小?字', '') AS koaza,
        oaza_cho || coalesce({{ chome_kanji('chome') }}, '') AS raw_name,
        koaza AS raw_koaza
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND oaza_cho IS NOT NULL
),
block AS (
    -- 番号に全角の数字が混じる行がある (「２１」)。ジオコーダーは半角で引くのでそろえる
    SELECT
        lg_code,
        regexp_replace(oaza_chome_name, '^大?字', '') AS oaza_chome_name,
        regexp_replace(koaza_name, '^小?字', '') AS koaza_name,
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
-- 小字が ABR に無い行 (ABR が大字・町だけを持つ「篠ノ井二ツ柳」に、位置参照情報が小字「大当」を付けている)
koaza_missing AS (
    SELECT b.*
    FROM block b
    WHERE b.koaza_name IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM town t
            WHERE t.lg_code = b.lg_code AND t.name = b.oaza_chome_name AND t.koaza = b.koaza_name
        )
),
matched AS (
    SELECT
        b.* EXCLUDE (raw_name, raw_koaza),
        t.machiaza_id,
        row_number() OVER (
            PARTITION BY b.lg_code, b.oaza_chome_name, b.koaza_name, b.block_number, b.is_residential_address
            ORDER BY (t.raw_name = b.raw_name AND t.raw_koaza IS NOT DISTINCT FROM b.raw_koaza) DESC, t.machiaza_id
        ) AS rank
    FROM block b
    JOIN town t
        ON t.lg_code = b.lg_code
        AND t.name = b.oaza_chome_name
        -- 小字のある行は同じ小字の町字に付ける
        AND (t.koaza = b.koaza_name OR (t.koaza IS NULL AND b.koaza_name IS NULL))
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
