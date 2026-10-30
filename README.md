# queria-geocoder

座標から都道府県・市区町村・町丁目のコードを返す逆ジオコーダー。試作中。

DuckDB もデータベースも使わない。地図用に R2 (`queria-assets`) へ置いた境界の PMTiles
(`scripts/build-boundary-tiles.sh`) から、点の入るタイルを Range で 1 枚だけ読み、点を含む多角形を
JS で探す。町丁目が当たれば、そのコードの頭 5 桁が市区町村、頭 2 桁が都道府県になる。
海沿いなどで町丁目に入らない点だけ、市区町村・都道府県のタイルを読みに行く。

## URL

```
GET /v1/reverse?lat=35.6812&lng=139.7671
→ {"lat":35.6812,"lng":139.7671,"prefecture":"13","city":"13101","small_area":"131010..."}
```

- どの区画にも入らない階層は `null`
- 座標が数値でない・範囲外は 400

## 精度

境界タイルは地図用に形を簡略化している (z13、タイル 1 枚を 4096 に刻む)。境目のすぐ近くの点は
隣の区画を返すことがある。`bench/` で全国の境界の表 (簡略化なし) と比べる。

```bash
uv run --with 'duckdb>=1.4,<2' python bench/truth.py 2000 > bench/points.csv
pnpm tsx bench/run.ts bench/points.csv
```

## 開発

```bash
pnpm --filter @queria/geocoder test
```

テストのタイル `test/fixture.pmtiles` は `test/make-fixture.py` で作る。
