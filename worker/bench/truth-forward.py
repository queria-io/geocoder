# 正引きのベンチマークに使う、住所と正解の座標の一覧を作る。元は 3 つの公開データで、どれも住所と緯度・経度を持つ。
# - land: 地価公示の標準地 (国交省、不動産情報ライブラリ)。所在は地番で書かれる
# - shelter: 指定避難所 (国土地理院)。市区町村が入れた住所で、郡を省いたものなどが混じる
# - kaigo: 介護サービス事業所 (厚労省)。事業者が入れた住所で、表記がいちばん揺れる
# 座標はどれも建物や土地の位置で、こちらが返す代表点とは同じ点ではない。誤差はその差も含む。
#
# 住所を書き方の型 (pattern) に分け、出典と型の組ごとに最大 k 件を選ぶ。無作為に選ぶと、よくある書き方
# (全角の数字、「番地」) ばかりになり、市区町村名のない住所や地割のような書き方がほとんど入らないため。
# 1 つの住所が複数の型に当てはまるときは、少ない型 (PATTERNS の上のもの) に入れる。
# 使い方: uv run --with 'duckdb>=1.4,<2' python bench/truth-forward.py 20 > bench/golden/truth-forward.csv
import sys, duckdb

k = int(sys.argv[1]) if len(sys.argv) > 1 else 20
data = "https://data.queria.io/datasets/queria"

PREF = r"^(東京都|北海道|京都府|大阪府|.{2,3}県)"
# (型, 当てはまる条件)。上から順に判定する
PATTERNS = [
    ("kyoto_street", r"regexp_matches(address, '(上る|上ル|下る|下ル|東入|西入)')"),
    ("chiwari", r"regexp_matches(address, '地割')"),
    # 数字の後の「丁」は「1丁目」の丁目を除く (除かないと、丁目のある住所がほとんどこの型に入る)
    ("kou_otsu", r"regexp_matches(address, '[甲乙丙丁][0-9０-９]|[0-9０-９][甲乙丙]|[0-9０-９]丁([^目]|$)|番[甲乙丙丁]')"),
    ("no_city", "NOT contains(address, city_name)"),
    ("no_pref", f"NOT regexp_matches(address, '{PREF}')"),
    ("no_county", "coalesce(county_name, '') <> '' AND NOT contains(address, county_name)"),
    ("kanji_chome", r"regexp_matches(address, '[一二三四五六七八九十]+丁目')"),
    ("building", r"regexp_matches(address, '(ビル|マンション|ハイツ|コーポ|アパート|号室|[0-9０-９]+[FＦ階])')"),
    ("aza", r"regexp_matches(address, '字')"),
    ("ban_go", r"regexp_matches(address, '番[0-9０-９]+号')"),
    ("banchi", r"regexp_matches(address, '番地')"),
    ("hyphen", r"regexp_matches(address, '[0-9０-９]+[-－‐ー][0-9０-９]+[-－‐ー][0-9０-９]+')"),
    ("fullwidth", r"regexp_matches(address, '[０-９]')"),
]
pattern = "CASE " + " ".join(f"WHEN {cond} THEN '{name}'" for name, cond in PATTERNS) + " ELSE 'other' END"

c = duckdb.connect()
c.sql("INSTALL ducklake; INSTALL httpfs")
for name in ["reinfolib", "gsi", "mhlw", "address_br"]:
    c.sql(f"ATTACH 'ducklake:{data}/{name}/ducklake.duckdb' AS {name} (READ_ONLY)")
c.sql(f"""
COPY (
  WITH land AS (
    SELECT 'land' AS source, CAST(point_id AS VARCHAR) AS id, location AS address,
      latitude AS lat, longitude AS lng, left(city_code, 5) AS city_code
    FROM reinfolib.main.mart_land_prices
    WHERE land_price_type = 0 AND year = (SELECT max(year) FROM reinfolib.main.mart_land_prices)
      AND location IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
  ),
  shelter AS (
    -- site_id は「E」＋市区町村コード 5 桁＋連番。政令市は区ではなく市のコード (横浜市は 14100)
    SELECT 'shelter', site_id, address, latitude, longitude, substr(site_id, 2, 5)
    FROM gsi.main.designated_shelter
    WHERE address IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
  ),
  kaigo AS (
    SELECT 'kaigo', establishment_number, address, latitude, longitude, city_code
    FROM mhlw.kaigo.establishment
    WHERE address IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY establishment_number ORDER BY service_type) = 1
  ),
  rows AS (SELECT * FROM land UNION ALL SELECT * FROM shelter UNION ALL SELECT * FROM kaigo),
  cities AS (
    SELECT lg_code_5 AS city_code, any_value(county_name) AS county_name, any_value(city_name) AS city_name
    FROM address_br.main.mart_city GROUP BY ALL
  ),
  typed AS (
    SELECT r.*, {pattern} AS pattern
    -- 今の市区町村の一覧に無いコード (合併や区の再編の前のもの) の住所も落とさない
    FROM rows r LEFT JOIN cities USING (city_code)
    WHERE r.city_code IS NOT NULL
  )
  SELECT source, id, address, lat, lng, city_code, pattern
  FROM typed
  -- 同じ住所の一覧が毎回できるよう、無作為ではなく id のハッシュの順で取る
  QUALIFY row_number() OVER (PARTITION BY source, pattern ORDER BY hash(id), id) <= {k}
  ORDER BY source, pattern, id
) TO '/dev/stdout' (HEADER, DELIMITER ',')
""")
