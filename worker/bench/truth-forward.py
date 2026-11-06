# 正引きのベンチマークに使う、住所と正解の座標の一覧を作る。元は 5 つの公開データで、どれも住所と緯度・経度を持つ。
# - land: 地価公示の標準地 (国交省、不動産情報ライブラリ)。所在は地番で書かれる
# - shelter: 指定避難所 (国土地理院)。市区町村が入れた住所で、郡を省いたものなどが混じる
# - kaigo: 介護サービス事業所 (厚労省)。事業者が入れた住所で、表記がいちばん揺れる
# - school: 学校 (国土数値情報)。開校中のものだけ
# - shougai: 障害福祉サービス事業所 (厚労省)。事業者が入れた住所
# 座標はどれも建物や土地の位置で、こちらが返す代表点とは同じ点ではない。誤差はその差も含む。
#
# 住所を書き方の型 (pattern) に分け、出典と型の組ごとに最大 k 件を選ぶ。無作為に選ぶと、よくある書き方
# (全角の数字、「番地」) ばかりになり、市区町村名のない住所や地割のような書き方がほとんど入らないため。
# 1 つの住所が複数の型に当てはまるときは、少ない型 (PATTERNS の上のもの) に入れる。
# 照合の規則を直すときに結果を見た住所 (bench/exclude.csv の source と id) は選ばない。見た住所に合わせた
# 改善で、ベンチマークの値が実力より高く出ないようにするため。
# 正解の座標が住所の場所でない住所 (bench/wrong-truth.csv、市区町村の役所の点が入っているものなど) も選ばない。
# 型の判定に使う町字 (town) は、同じ市区町村の町字のうち、大字・町の名前が住所の中に現れるもの。
# 使い方: uv run --with 'duckdb>=1.4,<2' python bench/truth-forward.py 20 > bench/golden/truth-forward.csv
import os, sys, duckdb

k = int(sys.argv[1]) if len(sys.argv) > 1 else 20
data = "https://data.queria.io/datasets/queria"
here = os.path.dirname(os.path.abspath(__file__))
exclude = os.path.join(here, "exclude.csv")
wrong = os.path.join(here, "wrong-truth.csv")

PREF = r"^(東京都|北海道|京都府|大阪府|.{2,3}県)"
# (型, 当てはまる条件)。上から順に判定する
PATTERNS = [
    ("kyoto_street", r"regexp_matches(address, '(上る|上ル|下る|下ル|東入|西入)')"),
    ("chiwari", r"regexp_matches(address, '地割')"),
    # 「1字」「二字」のような番号付きの小字を持つ大字・町で、大字・町の名前のすぐ後ろに番号を書いた住所
    ("num_koaza", r"""EXISTS (SELECT 1 FROM town t WHERE t.city5 = r.city_code
        AND regexp_full_match(t.koaza_raw, '[0-9０-９一二三四五六七八九十]+字')
        AND strpos(r.address, t.oaza) > 0
        AND regexp_matches(substr(r.address, strpos(r.address, t.oaza) + length(t.oaza)), '^[0-9０-９]+([^0-9０-９丁]|$)'))"""),
    # 番号を「28街区28号」「25区486番」「15号5番」と書く住所
    ("gaiku_go", r"regexp_matches(address, '[0-9０-９]+(街区|区)[0-9０-９]|[0-9０-９]+号[0-9０-９]+番')"),
    # 町名に数字の入る住所 (「東9条」「古町通6番町」)。位置参照情報は漢数字で書く
    ("jou_bancho", r"regexp_matches(address, '[0-9０-９一二三四五六七八九十]+(条|番町)')"),
    # 町名の「ケ」「ヶ」「ヵ」。ABR と位置参照情報で書き方が違うことがある
    ("ke", r"regexp_matches(address, '[一-龥][ケヶヵ][一-龥]')"),
    # 番号のすぐ後ろに空白なしで建物名が続く住所 (「88プレザンメゾン笠寺」)
    ("number_building", r"regexp_matches(address, '[0-9０-９][ァ-ヺ][ァ-ヺー]')"),
    # 数字の後の「丁」は「1丁目」の丁目を除く (除かないと、丁目のある住所がほとんどこの型に入る)
    ("kou_otsu", r"regexp_matches(address, '[甲乙丙丁][0-9０-９]|[0-9０-９][甲乙丙]|[0-9０-９]丁([^目]|$)|番[甲乙丙丁]')"),
    ("no_city", "NOT contains(address, city_name)"),
    ("no_pref", f"NOT regexp_matches(address, '{PREF}')"),
    ("no_county", "coalesce(county_name, '') <> '' AND NOT contains(address, county_name)"),
    ("kanji_chome", r"regexp_matches(address, '[一二三四五六七八九十]+丁目')"),
    ("building", r"regexp_matches(address, '(ビル|マンション|ハイツ|コーポ|アパート|号室|[0-9０-９]+[FＦ階])')"),
    # 小字で番号を振り直さない (起番フラグが 0 の) 町字に、小字の名前を書いた住所
    ("aza_nonstart", r"""EXISTS (SELECT 1 FROM town t WHERE t.city5 = r.city_code
        AND t.koaza IS NOT NULL AND t.wake_num_flg = '0' AND length(t.koaza) >= 2
        AND strpos(r.address, t.oaza) > 0
        AND strpos(substr(r.address, strpos(r.address, t.oaza) + length(t.oaza)), t.koaza) > 0)"""),
    ("aza", r"regexp_matches(address, '字')"),
    ("ban_go", r"regexp_matches(address, '番[0-9０-９]+号')"),
    ("banchi", r"regexp_matches(address, '番地')"),
    # 丁目のある町字と丁目の無い町字が同じ大字・町の名前で両方ある地域で、丁目を書かずに「○-○-○」と書いた住所
    # (「胡屋2-12-10」は胡屋二丁目 12-10 とも、字胡屋 2-12-10 とも読める)
    ("chome_omitted", r"""NOT contains(r.address, '丁目') AND EXISTS (SELECT 1 FROM town t WHERE t.city5 = r.city_code
        AND t.chome IS NOT NULL AND strpos(r.address, t.oaza) > 0
        AND regexp_matches(substr(r.address, strpos(r.address, t.oaza) + length(t.oaza)),
                           '^[0-9０-９]+[-－‐ー−][0-9０-９]+[-－‐ー−][0-9０-９]+')
        AND EXISTS (SELECT 1 FROM town u WHERE u.lg_code = t.lg_code AND u.oaza = t.oaza
                    AND u.chome IS NULL AND u.koaza IS NULL))"""),
    ("hyphen", r"regexp_matches(address, '[0-9０-９]+[-－‐ー][0-9０-９]+[-－‐ー][0-9０-９]+')"),
    ("fullwidth", r"regexp_matches(address, '[０-９]')"),
]
pattern = "CASE " + " ".join(f"WHEN {cond} THEN '{name}'" for name, cond in PATTERNS) + " ELSE 'other' END"

c = duckdb.connect()
c.sql("INSTALL ducklake; INSTALL httpfs; INSTALL spatial; LOAD spatial")
for name in ["reinfolib", "gsi", "mhlw", "nlftp", "address_br"]:
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
    -- site_id は「E」＋市区町村コード 5 桁＋連番。政令市は区ではなく市のコード (横浜市は 14100)。
    -- 指定した市区町村のコードで、所在地と違うことがある (室蘭市の住所に登別市のコード)
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
  school AS (
    SELECT 'school', school_code, address, ST_Y(geometry), ST_X(geometry), admin_code
    FROM nlftp.facility.school
    WHERE address IS NOT NULL AND geometry IS NOT NULL AND school_status = '開校中'
  ),
  shougai AS (
    -- 住所は都道府県・市区町村 (address_city) とそれより後ろ (address_detail) に分かれている。
    -- city_code は所在地ではなく指定した自治体 (都道府県のこともある) のコードなので、市区町村は address_city から決める
    SELECT 'shougai', s.establishment_number, s.address_city || s.address_detail, s.latitude, s.longitude, c.lg_code_5
    FROM mhlw.shougai.establishment s
    JOIN (
      SELECT DISTINCT lg_code_5, pref_name || coalesce(county_name, '') || city_name || coalesce(ward_name, '') AS name
      FROM address_br.main.mart_city
    ) c ON c.name = s.address_city
    WHERE s.address_detail IS NOT NULL AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY s.establishment_number ORDER BY s.service_type) = 1
  ),
  rows AS (
    SELECT * FROM land UNION ALL SELECT * FROM shelter UNION ALL SELECT * FROM kaigo
    UNION ALL SELECT * FROM school UNION ALL SELECT * FROM shougai
  ),
  town AS (
    SELECT DISTINCT left(lg_code, 5) AS city5, lg_code,
      regexp_replace(oaza_cho, '^大?字', '') AS oaza, chome,
      regexp_replace(koaza, '^小?字', '') AS koaza, koaza AS koaza_raw, wake_num_flg
    FROM address_br.main.mart_town
    WHERE status_flg <> '3' AND oaza_cho IS NOT NULL
  ),
  excluded AS (
    SELECT source, id FROM read_csv('{exclude}', all_varchar = true)
    UNION ALL
    SELECT source, id FROM read_csv('{wrong}', all_varchar = true)
  ),
  cities AS (
    SELECT lg_code_5 AS city_code, any_value(county_name) AS county_name, any_value(city_name) AS city_name
    FROM address_br.main.mart_city GROUP BY ALL
  ),
  typed AS (
    SELECT r.*, {pattern} AS pattern
    -- 今の市区町村の一覧に無いコード (合併や区の再編の前のもの) の住所も落とさない
    FROM rows r LEFT JOIN cities USING (city_code)
    WHERE r.city_code IS NOT NULL AND (r.source, r.id) NOT IN (SELECT source, id FROM excluded)
  )
  SELECT source, id, address, lat, lng, city_code, pattern
  FROM typed
  -- 同じ住所の一覧が毎回できるよう、無作為ではなく id のハッシュの順で取る
  QUALIFY row_number() OVER (PARTITION BY source, pattern ORDER BY hash(id), id) <= {k}
  ORDER BY source, pattern, id
) TO '/dev/stdout' (HEADER, DELIMITER ',')
""")
