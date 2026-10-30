# 境目のすぐ近くだけの答え合わせ用の点を作る (truth.py の続き)。町丁目を無作為に選び、
# 外周の線上の 1 点から、どちらかの向きへ 0〜3m ずらす。正解は全国の町丁目から ST_Contains で
# 引き直す (ずらした先は隣の町丁目かもしれない)。どこにも入らない点 (海など) は落とす。
# 使い方: uv run --with 'duckdb>=1.4,<2' python bench/truth-border.py 3000 > bench/border.csv
import sys, duckdb

n = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
data = "https://data.queria.io/datasets/queria"
c = duckdb.connect()
c.sql("INSTALL spatial; LOAD spatial; INSTALL ducklake; INSTALL httpfs")
c.sql(f"ATTACH 'ducklake:{data}/e_stat/ducklake.duckdb' AS e_stat (READ_ONLY)")
c.sql("""CREATE TABLE areas AS
  SELECT CAST(key_code AS VARCHAR) AS code, geometry FROM e_stat.boundary.small_area""")
c.sql(f"""
COPY (
  WITH picked AS (SELECT * FROM areas USING SAMPLE {n} ROWS (reservoir, 7)),
  rings AS (
    SELECT code, geometry, ST_ExteriorRing(unnest(ST_Dump(geometry)).geom) AS ring FROM picked
    QUALIFY row_number() OVER (PARTITION BY code ORDER BY ST_Length(ring) DESC) = 1
  ),
  edge AS (SELECT code, ST_LineInterpolatePoint(ring, random()) AS e, random() * 3 AS d,
    random() * 2 * pi() AS a FROM rings),
  -- 度と m の換算は大まかでよい (緯度 1 度 ≒ 111km、経度は cos(緯度) 倍)
  pts AS (SELECT ST_Point(ST_X(e) + d * cos(a) / (111000 * cos(radians(ST_Y(e)))),
                          ST_Y(e) + d * sin(a) / 111000) AS p FROM edge)
  SELECT a.code, round(ST_X(p), 8) AS lng, round(ST_Y(p), 8) AS lat,
    round(ST_Distance(p, ST_Boundary(a.geometry)) * 111000 * cos(radians(ST_Y(p))), 2) AS border_m
  FROM pts JOIN areas a ON ST_Contains(a.geometry, p)
  ORDER BY a.code
) TO '/dev/stdout' (HEADER, DELIMITER ',')
""")
