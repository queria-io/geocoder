# 正引きの物差しに使う、実際の住所と座標の組を作る。元は 3 つの公開データで、どれも住所と緯度・経度を持つ。
# - land: 地価公示の標準地 (国交省、不動産情報ライブラリ)。所在は地番で書かれる
# - shelter: 指定避難所 (国土地理院)。市区町村が入れた住所で、郡を省いたものなどが混じる
# - kaigo: 介護サービス事業所 (厚労省)。事業者が入れた住所で、表記がいちばん揺れる
# 座標はどれも建物や土地の位置で、こちらが返す代表点とは同じ点ではない。誤差はその差も含む。
# 使い方: uv run --with 'duckdb>=1.4,<2' python bench/truth-forward.py 1000 > bench/truth-forward.csv
import sys, duckdb

n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
data = "https://data.queria.io/datasets/queria"
c = duckdb.connect()
c.sql("INSTALL ducklake; INSTALL httpfs")
for name in ["reinfolib", "gsi", "mhlw"]:
    c.sql(f"ATTACH 'ducklake:{data}/{name}/ducklake.duckdb' AS {name} (READ_ONLY)")
c.sql(f"""
COPY (
  WITH land AS (
    SELECT 'land' AS source, CAST(point_id AS VARCHAR) AS id, location AS address,
      latitude AS lat, longitude AS lng, left(city_code, 5) AS city_code
    FROM reinfolib.main.mart_land_prices
    WHERE land_price_type = 0 AND year = (SELECT max(year) FROM reinfolib.main.mart_land_prices)
      AND location IS NOT NULL AND latitude IS NOT NULL
    USING SAMPLE {n} ROWS (reservoir, 42)
  ),
  shelter AS (
    -- site_id は「E」＋市区町村コード 5 桁＋連番
    SELECT 'shelter', site_id, address, latitude, longitude, substr(site_id, 2, 5)
    FROM gsi.main.designated_shelter
    WHERE address IS NOT NULL AND latitude IS NOT NULL
    USING SAMPLE {n} ROWS (reservoir, 42)
  ),
  kaigo AS (
    SELECT 'kaigo', establishment_number, address, latitude, longitude, city_code
    FROM (
      SELECT * FROM mhlw.kaigo.establishment
      WHERE address IS NOT NULL AND latitude IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY establishment_number ORDER BY service_type) = 1
    )
    USING SAMPLE {n} ROWS (reservoir, 42)
  )
  SELECT * FROM land UNION ALL SELECT * FROM shelter UNION ALL SELECT * FROM kaigo
  ORDER BY source, id
) TO '/dev/stdout' (HEADER, DELIMITER ',')
""")
