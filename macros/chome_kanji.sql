-- ABR の丁目 (「３丁目」) を、位置参照情報の書き方 (「三丁目」) にする。1〜99 丁目。数字でなければそのまま
{% macro chome_kanji(col) -%}
(
    WITH n AS (
        SELECT TRY_CAST(regexp_extract(translate({{ col }}, '０１２３４５６７８９', '0123456789'), '^([0-9]+)丁目$', 1) AS INT) AS n
    )
    SELECT CASE WHEN n IS NULL OR n NOT BETWEEN 1 AND 99 THEN {{ col }} ELSE
        (CASE WHEN n // 10 = 0 THEN '' WHEN n // 10 = 1 THEN '十' ELSE substr('一二三四五六七八九', n // 10, 1) || '十' END)
        || (CASE WHEN n % 10 = 0 THEN '' ELSE substr('一二三四五六七八九', n % 10, 1) END) || '丁目'
    END FROM n
)
{%- endmacro %}
