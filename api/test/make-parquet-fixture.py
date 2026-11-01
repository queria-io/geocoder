# テストの Parquet (test/fixture-town.parquet) を作る。本物と同じく lg_code 順・zstd で、
# 行グループを小さくして、市区町村が行グループをまたぐ場合と 1 つに収まる場合を両方作る
import duckdb

# DuckDB は行グループを 2,048 行 (ベクトル 1 本) より細かく切らないので、その単位で組む。
# 131016 は 3,000 行で行グループ 0〜1 にまたがり、131024 は 1 に収まり、132012 は 1〜2 にまたがる
rows = [("131016", f"{i:07d}", f"町{i}", 139.75, 35.68) for i in range(3000)]
rows += [("131024", f"{i:07d}", f"中{i}", 139.77, 35.67) for i in range(1000)]
rows += [("132012", f"{i:07d}", f"八{i}", 139.32, 35.66) for i in range(2000)]

con = duckdb.connect()
con.execute("CREATE TABLE town (lg_code VARCHAR, machiaza_id VARCHAR, oaza_cho VARCHAR, lng DOUBLE, lat DOUBLE)")
con.executemany("INSERT INTO town VALUES (?, ?, ?, ?, ?)", rows)
con.execute(
    "COPY (SELECT * FROM town ORDER BY lg_code, machiaza_id) TO 'api/test/fixture-town.parquet' "
    "(FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 2048)"
)
