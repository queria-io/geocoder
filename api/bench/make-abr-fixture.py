"""ABR の町字・市区町村・都道府県マスタの CSV から、geocoder の town・city・pref の表と同じ列の JSON を作る。
上流の試験 (bench/upstream-issues.test.ts) を、data.queria.io に届かない場所でも流すため。

    uv run --with duckdb python bench/make-abr-fixture.py <CSV のあるフォルダ> bench/abr/ [rsdtdsp.parquet]

3 つ目に geocoder の rsdtdsp の表の Parquet を渡すと、bench/abr/rsdtdsp.parquet に写し、town に
住居表示の住所の数 (rsdtdsp_count) を足す。渡さなければ 0 にする (番・号の段は流れない)。
CSV は https://dataset.address-br.digital.go.jp/ の mt_town_all.csv・mt_city_all.csv・mt_pref_all.csv。
"""

import sys
from pathlib import Path

import duckdb

src, out = Path(sys.argv[1]), Path(sys.argv[2])
rsdtdsp = Path(sys.argv[3]) if len(sys.argv) > 3 else None
out.mkdir(parents=True, exist_ok=True)
con = duckdb.connect()
if rsdtdsp:
    # dbt_project.yml と同じ行グループ・圧縮で、machiaza_key の順に書き直す
    con.sql(f"""
    COPY (SELECT * FROM read_parquet('{rsdtdsp}') ORDER BY machiaza_key, blk_id, rsdt_id NULLS FIRST, rsdt2_id NULLS FIRST)
    TO '{out / 'rsdtdsp.parquet'}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 30720)
    """)
    con.sql(f"CREATE VIEW rsdtdsp_count AS SELECT lg_code, machiaza_id, count(*)::INTEGER AS n FROM read_parquet('{out / 'rsdtdsp.parquet'}') GROUP BY ALL")
else:
    con.sql("CREATE VIEW rsdtdsp_count AS SELECT NULL::VARCHAR AS lg_code, NULL::VARCHAR AS machiaza_id, 0 AS n WHERE false")
# macros/half_width.sql と同じ: 名前の全角の英数字・記号を半角に
FULL = "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ！＂＃＄％＆＇（）＊＋，－．／：；＜＝＞？＠［＼］＾＿｀｛｜｝～"
HALF = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
con.execute("CREATE MACRO half_width(s) AS translate(s, $full, $half)".replace("$full", "'" + FULL + "'").replace("$half", "'" + HALF.replace("'", "''") + "'"))
con.sql(f"CREATE VIEW raw_town AS SELECT * FROM read_csv('{src / 'mt_town_all.csv'}', all_varchar=true)")
# town.sql と同じく、町字 ID ごとに 1 行 (住居表示の行を残す)。代表点と小地域は試験に使わないので省く
con.sql(f"""
COPY (
    WITH town AS (
        SELECT *, count(DISTINCT rsdt_addr_flg) OVER (PARTITION BY lg_code, machiaza_id) > 1 AS rsdt_addr_partial
        FROM raw_town
        WHERE status_flg <> '3'
        QUALIFY row_number() OVER (PARTITION BY lg_code, machiaza_id ORDER BY rsdt_addr_flg DESC, efct_date DESC NULLS LAST) = 1
    ),
    oaza_has_chome AS (SELECT DISTINCT lg_code, oaza_cho FROM town WHERE chome IS NOT NULL)
    SELECT
        t.lg_code, t.machiaza_id, t.pref AS pref_name, half_width(t.county) AS county_name,
        half_width(t.city) AS city_name, half_width(t.ward) AS ward_name, half_width(t.oaza_cho) AS oaza_cho,
        half_width(t.chome) AS chome, half_width(t.koaza) AS koaza,
        t.koaza_aka_code = '2' AS kyoto_street, half_width(t.machiaza_dist) AS machiaza_dist,
        t.chome IS NOT NULL OR t.oaza_cho LIKE '%丁目' OR h.oaza_cho IS NOT NULL AS has_chome,
        coalesce(c.n, 0) AS rsdtdsp_count, t.rsdt_addr_flg, t.rsdt_addr_partial
    FROM town t
    LEFT JOIN oaza_has_chome h ON h.lg_code = t.lg_code AND h.oaza_cho = t.oaza_cho
    LEFT JOIN rsdtdsp_count c ON c.lg_code = t.lg_code AND c.machiaza_id = t.machiaza_id
    ORDER BY t.lg_code, t.machiaza_id
) TO '{out / 'town.json'}' (FORMAT json, ARRAY true)
""")
con.sql(f"""
COPY (
    SELECT lg_code, left(lg_code, 2) AS pref_code, pref AS pref_name, half_width(county) AS county_name,
        half_width(city) AS city_name, half_width(ward) AS ward_name
    FROM read_csv('{src / 'mt_city_all.csv'}', all_varchar=true) ORDER BY lg_code
) TO '{out / 'city.json'}' (FORMAT json, ARRAY true)
""")
con.sql(f"""
COPY (
    SELECT lg_code, left(lg_code, 2) AS pref_code, pref AS pref_name
    FROM read_csv('{src / 'mt_pref_all.csv'}', all_varchar=true) ORDER BY lg_code
) TO '{out / 'pref.json'}' (FORMAT json, ARRAY true)
""")
