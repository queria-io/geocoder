# queria-geocoder

座標から都道府県・市区町村・町丁目のコードを返す逆ジオコーダー。試作中。

DuckDB もデータベースも使わない。地図用に R2 (`queria-assets`) へ置いた境界の PMTiles
(`scripts/build-boundary-tiles.sh`) から、点の入るタイルを Range で 1 枚だけ読み、点を含む多角形を
JS で探す。町丁目が当たれば、そのコードの頭 5 桁が市区町村、頭 2 桁が都道府県になる。
海沿いなどで町丁目に入らない点だけ、市区町村・都道府県のタイルを読みに行く。

## URL

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

正引きを足すときも同じ形にする。番・号まで当たったときは ABR の ID (`machiaza_id` など) を足し、
`match.level` に当たった段 (住居・街区・地番・町字・大字)、`match.method` に座標の出どころ
(ABR の代表点・位置参照情報など) を入れる。代表点しか無いのに建物の精度に見える答えは返さない。

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
pnpm --filter @queria/geocoder test
```

テストのタイル `test/fixture.pmtiles` は `test/make-fixture.py` で作る。
