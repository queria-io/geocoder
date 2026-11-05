-- 名前の中の 1〜99 の算用数字 (全角も) を漢数字にする (「東9条2丁目」→「東九条二丁目」、「16地割」→「十六地割」)。
-- 位置参照情報は町名の数字を漢数字で書くので、ABR の名前をこの形にして突き合わせる。100 以上はそのまま
{% macro kanji_numerals(col) -%}
array_to_string(
    list_transform(
        regexp_extract_all(translate({{ col }}, '０１２３４５６７８９', '0123456789'), '[0-9]+|[^0-9]+'),
        x -> CASE WHEN regexp_full_match(x, '[1-9][0-9]?') THEN
            (CASE WHEN CAST(x AS INT) // 10 = 0 THEN '' WHEN CAST(x AS INT) // 10 = 1 THEN '十'
                ELSE substr('一二三四五六七八九', CAST(x AS INT) // 10, 1) || '十' END)
            || (CASE WHEN CAST(x AS INT) % 10 = 0 THEN '' ELSE substr('一二三四五六七八九', CAST(x AS INT) % 10, 1) END)
        ELSE x END
    ),
    ''
)
{%- endmacro %}
