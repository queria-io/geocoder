# 人が書いた住所と、その場所の座標が両方載っている公開データから、正引きの試験の入力を作る。
# Queria の公開データセットを読むだけで、ジオコーダーの照合は通さない（正解は元の台帳の座標）。
#
# 出す CSV（bench/real/ に書く。*.csv は git に入れない）:
#   land_price.csv  地価公示・地価調査の地点（最新年）。所在は地番の書き方が多い。座標は現地で決めた点
#   kaigo.csv       介護サービス事業所。座標は事業所の申告や別のジオコーダーの値が混ざりうる
#   shelter.csv     指定避難所。座標は市区町村の申告
# 列: source,id,city_code,address,lat,lng
#
# 使い方: uv run --with 'duckdb>=1.4,<2' python bench/real_addresses.py [出力先]
#
# 出典:
#   地価公示・都道府県地価調査（国土交通省 不動産情報ライブラリ、政府標準利用規約 第2.0版）
#   介護サービス情報公表システムのオープンデータ（厚生労働省、公共データ利用規約 第1.0版）
#   指定緊急避難場所・指定避難所データ（国土地理院、国土地理院コンテンツ利用規約）
import sys
from pathlib import Path

import duckdb

out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "real")
out.mkdir(parents=True, exist_ok=True)
data = "https://data.queria.io/datasets/queria"

c = duckdb.connect()
c.sql("INSTALL ducklake; INSTALL httpfs")
for ds in ("reinfolib", "mhlw", "gsi"):
    c.sql(f"ATTACH 'ducklake:{data}/{ds}/ducklake.duckdb' AS {ds} (READ_ONLY)")

queries = {
    # 地点ごとに最新年の 1 行。「外」は隣の筆も含む地点の印なので、住所としては外す
    "land_price": """
        SELECT 'land_price' AS source, CAST(point_id AS VARCHAR) AS id, city_code,
          regexp_replace(location, '外$', '') AS address, latitude AS lat, longitude AS lng
        FROM reinfolib.main.mart_land_prices
        WHERE year = (SELECT max(year) FROM reinfolib.main.mart_land_prices)
          AND location IS NOT NULL AND latitude IS NOT NULL
        QUALIFY row_number() OVER (PARTITION BY standard_lot_number, land_price_type ORDER BY point_id) = 1
    """,
    # 同じ住所に複数のサービスがあるので、住所ごとに 1 行
    "kaigo": """
        SELECT 'kaigo' AS source, any_value(establishment_number) AS id, any_value(local_gov_code) AS city_code,
          address, any_value(latitude) AS lat, any_value(longitude) AS lng
        FROM mhlw.kaigo.establishment
        WHERE address IS NOT NULL AND latitude IS NOT NULL
        GROUP BY address
    """,
    "shelter": """
        SELECT 'shelter' AS source, site_id AS id, NULL AS city_code,
          address, latitude AS lat, longitude AS lng
        FROM gsi.main.designated_shelter
        WHERE address IS NOT NULL AND latitude IS NOT NULL
    """,
}
for name, sql in queries.items():
    path = out / f"{name}.csv"
    c.sql(f"COPY ({sql} ORDER BY id) TO '{path.as_posix()}' (HEADER)")
    n = c.sql(f"SELECT count(*) FROM read_csv('{path.as_posix()}')").fetchone()[0]
    print(f"{name}: {n} 行 -> {path}")
