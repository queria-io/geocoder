# 逆引きの答え合わせ用の点を作る。町丁目を無作為に選び、その中に点を 1 つ置く。
# 正解は全国の境界の表 (簡略化していない) で ST_Contains した町丁目のコード。
# 境目からの距離 (m) も出して、タイルの簡略化で外れるのが境目の近くだけかを見る。
# 使い方: uv run --with 'duckdb>=1.4,<2' python bench/truth.py 2000 > bench/points.csv
import sys, duckdb

n = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
data = "https://data.queria.io/datasets/queria"
c = duckdb.connect()
c.sql("INSTALL spatial; LOAD spatial; INSTALL ducklake; INSTALL httpfs")
c.sql(f"ATTACH 'ducklake:{data}/e_stat/ducklake.duckdb' AS e_stat (READ_ONLY)")
c.sql(f"""
COPY (
  WITH areas AS (
    SELECT CAST(key_code AS VARCHAR) AS code, geometry FROM e_stat.boundary.small_area
    USING SAMPLE {n} ROWS (reservoir, 42)
  ),
  candidates AS (
    SELECT code, geometry, i,
      ST_Point(ST_XMin(geometry) + random() * (ST_XMax(geometry) - ST_XMin(geometry)),
               ST_YMin(geometry) + random() * (ST_YMax(geometry) - ST_YMin(geometry))) AS p
    FROM areas, range(30) t(i)
  ),
  inside AS (
    SELECT code, geometry, p FROM candidates WHERE ST_Contains(geometry, p)
    QUALIFY row_number() OVER (PARTITION BY code ORDER BY i) = 1
  )
  SELECT code, round(ST_X(p), 7) AS lng, round(ST_Y(p), 7) AS lat,
    -- 度を m に直す。経度は緯度で縮むが、境目までの距離の桁を見るだけなので大まかでよい
    round(ST_Distance(p, ST_Boundary(geometry)) * 111000 * cos(radians(ST_Y(p))), 1) AS border_m
  FROM inside ORDER BY code
) TO '/dev/stdout' (HEADER, DELIMITER ',')
""")
