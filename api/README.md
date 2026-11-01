# geocoder

日本の住所と座標・地域コードを相互に引く API。無料のベータとして geocoder.queria.io で出している。ベータの間は答えの形を変えることがある。IP ごとに 1 分 300 回までで、超えると 429。

DuckDB もデータベースも使わない。地図用に R2 (`queria-assets`) へ置いた境界の PMTiles
(queria-web の `scripts/build-boundary-tiles.sh`) から、点の入るタイルを Range で 1 枚だけ読み、点を含む多角形を
JS で探す。町丁目が当たれば、そのコードの頭 5 桁が市区町村、頭 2 桁が都道府県になる。
海沿いなどで町丁目に入らない点だけ、市区町村・都道府県のタイルを読みに行く。

## URL

入口は Hono と @hono/zod-openapi。仕様書は `GET /openapi.json`（OpenAPI 3.1）で、型と入力の検査も同じ定義から作る。判定のロジック (`src/lookup.ts`) は Hono に依らない純関数のまま。

```
GET /v1/reverse?lat=35.6812&lng=139.7671
```

```json
{
  "lat": 35.6812,
  "lng": 139.7671,
  "country": "JP",
  "prefecture_code": "13",
  "city_code": "13101",
  "estat_small_area_code": "131010...",
  "match": { "level": "small_area", "method": "polygon" },
  "source": {
    "boundaries": "boundaries-20261027.pmtiles",
    "attribution": ["「国勢調査 境界データ（小地域）」（総務省統計局、e-Stat）を加工して作成"]
  }
}
```

- コードは名前でどの体系か分かるようにする。`estat_small_area_code` は国勢調査の小地域 (KEY_CODE) で、
  住所の町字 (ABR の machiaza_id) とは別のもの。町字との対応は japan_address_code の town_small_area
- `match.level` は点が実際に入った多角形の階層。上の階層のコードはそのコードの頭から取る。
  どの区画にも入らない階層は `null`
- `source` は答えを作ったデータのバージョンと出典表示。出典は表示が要るので、答えを転載するときは一緒に載せる
- 座標が数値でない・範囲外は 400

```
GET /v1/geocode?address=東京都千代田区紀尾井町1-3&limit=1
```

住所は URL エンコードして渡す。日本語をそのまま URL に入れると、Worker に届く前に Cloudflare の入口が本文の無い 400 を返す。
ブラウザや多くの HTTP ライブラリは自分で直すが、curl は直さない。

```bash
curl -s -G https://geocoder.queria.io/v1/geocode --data-urlencode "address=東京都千代田区紀尾井町1-3"
```

- `results` は強い順。`limit` (1〜10、既定 1) まで返す
- コードは逆引きと同じ名前で、`prefecture_code` (2 桁)・`city_code` (5 桁)・`lg_code` (6 桁、検査数字つき) を返す
- `match_level` は住所がどこまで当たったか、`coordinate_level` は座標を取った点 (号・街区・地番の筆・町字・市区町村・都道府県の代表点)。
  番号まで当たってもその点に座標が無ければ町字の代表点で埋め、`coordinate_level` が `machiaza` になる。どれも代表点で、建物の位置ではない
- `source.tables` は答えに使った表のファイル、`source.attribution` は出典表示。答えを載せるときは一緒に載せる

## 精度

境界タイルは地図用に形を簡略化している (z13、タイル 1 枚を 4096 に刻む)。境目のすぐ近くの点は
隣の区画を返すことがある。`bench/` で全国の境界の表 (簡略化なし) と比べる。

```bash
uv run --with 'duckdb>=1.4,<2' python bench/truth.py 2000 > bench/points.csv
pnpm tsx bench/run.ts bench/points.csv
# 境目から 3m 以内の点だけで測る
uv run --with 'duckdb>=1.4,<2' python bench/truth-border.py 3000 > bench/border.csv
pnpm tsx bench/run.ts bench/border.csv
```

## 開発

```bash
pnpm test
```

テストのタイル `test/fixture.pmtiles` は `test/make-fixture.py` で作る。
