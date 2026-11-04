-- 丁目の番号。「5丁目」「５丁目」「五丁目」「十二丁目」「1丁」(堺市) を 5・5・5・12・1 にする。番号の無いものは NULL
{% macro chome_number(col) -%}
(
    WITH k AS (
        SELECT regexp_extract(translate({{ col }}, '０１２３４５６７８９', '0123456789'), '^([0-9一二三四五六七八九十]+)丁目?$', 1) AS k
    ),
    d AS (SELECT ['一', '二', '三', '四', '五', '六', '七', '八', '九'] AS d)
    SELECT CASE
        WHEN k IS NULL OR k = '' THEN NULL
        WHEN regexp_matches(k, '^[0-9]+$') THEN CAST(k AS INTEGER)
        WHEN NOT contains(k, '十') THEN nullif(list_position(d, k), 0)
        ELSE coalesce(nullif(list_position(d, split_part(k, '十', 1)), 0), 1) * 10
            + coalesce(nullif(list_position(d, split_part(k, '十', 2)), 0), 0)
    END
    FROM k, d
)
{%- endmacro %}
