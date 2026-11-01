# geocoder

日本の住所と座標・地域コードを相互に引く API。無料のベータとして geocoder.queria.io で出している。ベータの間は答えの形を変えることがある。IP ごとに 1 分 300 回までで、超えると 429。

DuckDB もデータベースも使わない。地図用に R2 (`queria-assets`) へ置いた境界の PMTiles
(queria-web の `scripts/build-boundary-tiles.sh`) から、点の入るタイルを Range で 1 枚だけ読み、点を含む多角形を
JS で探す。町丁目が当たれば、そのコードの頭 5 桁が市区町村、頭 2 桁が都道府県になる。
海沿いなどで町丁目に入らない点だけ、市区町村・都道府県のタイルを読みに行く。

## URL

入口は Hono と @hono/zod-openapi。仕様書は `GET /openapi.json`（OpenAPI 3.1）で、型と入力の検査も同じ定義から作る。判定のロジック (`src/lookup.ts`) は Hono に依らない純関数のまま。

項目名と段の値は abr-geocoder の答えにそろえる。既定の答えは最小限にして、ほかは `include` で頼んだときだけ足す。
頼んだ組の項目は、値が無くても null で入れる。

```
GET /v1/geocode?address=東京都千代田区紀尾井町1-3
```

```json
{
  "results": [{
    "matched_address": "東京都千代田区紀尾井町1-3",
    "unmatched_address": null,
    "lat": 35.679107, "lng": 139.736395,
    "match_level": "rsdtdsp_rsdt",
    "coordinates_level": "rsdtdsp_rsdt",
    "lg_code": "131016"
  }],
  "source": { "version": "geocoder-20261101", "attribution": ["「アドレス・ベース・レジストリ」（デジタル庁）…を加工して作成"] }
}
```

- `match_level` は住所がどこまで当たったか、`coordinates_level` は座標を取った点の段。番号まで当たってもその点に
  座標が無ければ町字の代表点で埋め、`coordinates_level` が `machiaza` になる。どれも代表点で、建物の位置ではない
- 当たらなければ `results` は空。`limit` (1〜10、既定 1) まで強い順に返す
- `include` (カンマ区切り): `match` (score)・`parts` (structured_address)・`ids` (ABR の ID)・
  `codes` (都道府県・市区町村コード、郵便番号、地域メッシュ)・`small_area` (国勢調査の小地域コード。境界タイルを 1 枚読む)
- `format`: `json` (既定)・`geojson` (abr-geocoder の /geocode と同じ FeatureCollection、abr-geocoder の項目は全部入る)・
  `csv` (1 件 1 行、BOM 付き UTF-8。入れ子は `structured_address.pref` のような列にほどく。出典は `X-Attribution` ヘッダに URL エンコードで入れる)
- `source.version` はデータのバージョン、`source.attribution` は出典表示。答えを載せるときは出典も一緒に載せる

住所は URL エンコードして渡す。日本語をそのまま URL に入れると、Worker に届く前に Cloudflare の入口が本文の無い 400 を返す。
ブラウザや多くの HTTP ライブラリは自分で直すが、curl は直さない。

```bash
curl -s -G https://geocoder.queria.io/v1/geocode --data-urlencode "address=東京都千代田区紀尾井町1-3" --data-urlencode "include=codes,small_area"
```

```
GET /v1/reverse?lat=35.6812&lng=139.7671
```

```json
{
  "lat": 35.6812, "lng": 139.7671,
  "lg_code": "131016",
  "estat_small_area_code": "13101001001",
  "match_level": "small_area",
  "source": { "version": "boundaries-20261027", "attribution": ["「国勢調査 境界データ（小地域）」（総務省統計局、e-Stat）を加工して作成"] }
}
```

- `estat_small_area_code` は国勢調査の小地域 (KEY_CODE) で、住所の町字 (ABR の machiaza_id) とは別のもの。
  町字との対応は japan_address_code の town_small_area
- `match_level` は点が実際に入った区画の階層 (`small_area`・`city`・`prefecture`)。どこにも入らなければ `null`
- `include=codes` で都道府県・市区町村コードと地域メッシュを足す
- 座標が数値でない・範囲外は 400

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
