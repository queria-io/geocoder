# Queria Geocoder

日本の住所を緯度・経度と地域コード（市区町村コード・国勢調査の小地域コード・地域メッシュコード）に変える、無料のジオコーダーです。地図上の点から住所を調べることもできます。登録はいりません。

- API の説明: https://geocoder.queria.io/docs
- API 仕様（OpenAPI）: https://geocoder.queria.io/openapi.json
- 精度の比較: 日本の住所 3,000 件でほかの無料のジオコーダーと比較した結果（[BENCHMARK.md](BENCHMARK.md)）
- 設計方針: 改修で守る 5 つの観点（精度・処理速度・メモリ使用量・データモデル・説明可能性）（[DESIGN.md](DESIGN.md)）

```bash
curl -s -G https://geocoder.queria.io/v1/forward --data-urlencode "address=東京都千代田区紀尾井町1-3"
```

## 利用条件

- 無料で提供している
- 負荷を抑えるため、1 つの IP アドレスから 1 分に 300 回までに制限している。超えると 429 を返す
- 結果を公開するときは、レスポンスの `source.attribution` に入っている出典も表示する
- geocoder.queria.io は、入力された住所と照合の結果を記録し、照合の改善と地域ごとの利用状況の集計に使う。IP アドレスなど、入力した人を特定できる情報は記録しない。記録されたくない場合は、このリポジトリの Worker を自分の環境で動かす（記録先のシークレット `REQUEST_LOG_URL`・`REQUEST_LOG_TOKEN` を設定しなければ記録しない）

## 市区町村名のない住所

「守山3-7-5」のように市区町村名を書かない住所は、町字の名前からその町字を持つ市区町村を探して照合する。同じ名前の町字が複数の市区町村にあるときは、候補を座標の細かさの順（号・地番の点を持つ候補が先、町字の代表点しかない候補が後）、同じ細かさなら人口の多い順に並べて返し、各結果の `ambiguous` を `true`、`candidates` を候補の数にする。

- `/v1/forward` と `/v1/forward/batch` は `limit` の数まで候補を返す（既定の `limit=1` では先頭の 1 件）。`/v1/forward/batch` は住所ごとに `/v1/forward` と同じ `{ "address", "results" }` を、渡した住所と同じ順・同じ数で返す
- `ambiguous` が `true` の結果は、市区町村を推定している。住所の地域がわかっている場合は、`prefecture_code`（都道府県コード 2 桁）か `city_code`（全国地方公共団体コード 5 桁か 6 桁）を付けると、その地域の結果だけを返す

## 統計データとの結合

`include=small_area` を付けると、国勢調査の小地域コード（`estat_small_area_code`）を返す。[Queria](https://queria.io) の公開データセットは同じコードで国勢調査の表を持っているので、SQL で結合できる。

```sql
-- 東京都千代田区紀尾井町1-3 の estat_small_area_code は 131010100
SELECT key_code, city_name, area_name, jinko, setai
FROM e_stat.boundary.small_area
WHERE key_code = '131010100'
```

## このリポジトリ

- 直下: ジオコーダーが読む表を作る Queria のデータセット `geocoder`（このページの以下）
- [`worker/`](worker/README.md): geocoder.queria.io を出す Cloudflare Worker（API と API の説明のページ）
- [`examples/addresses.csv`](examples/addresses.csv): `POST /v1/forward/batch` を試すための住所の CSV（役所などの住所と、郡や都道府県を省いたものなど書き方を変えたもの）

ライセンスは [MIT](LICENSE)。住所の照合の規則は [abr-geocoder](https://github.com/digital-go-jp/abr-geocoder)（デジタル庁、MIT ライセンス）を元にしている（[`worker/upstream/`](worker/upstream/README.md)）。

## データセット

元にするのは Queria の公開データセット [address_br](https://github.com/queria-io/dataset-address-br)（アドレス・ベース・レジストリ）、e_stat（国勢調査の小地域境界）、nlftp（国交省の街区・大字町丁目レベル位置参照情報）。取得はせず、それを読んで次の表を作る。

| 表 | 中身 |
|---|---|
| `town` | 町字の名前・別名・代表点と、代表点が入る小地域 |
| `town_name` | 大字・町の名前から、その名前を持つ市区町村を引く索引。市区町村名を書かない住所の照合に使う |
| `rsdtdsp_blk` | 住居表示の街区（「○番」）の代表点 |
| `rsdtdsp_rsdt` | 住居表示の住居（「○号」）の代表点 |
| `parcel` | 地番の住所と代表点（座標の付く筆は一部だけ） |
| `isj_block` | 国交省の位置参照情報の街区・地番の親番の点を町字に付けたもの |
| `address_point_candidate` | 住所ごとの代表点の候補（出典ごとに 1 行） |
| `address_point` | 住所ごとに選択した代表点（代表点のある住所のみ。出典が複数あれば優先順位の高い 1 つ）。ジオコーダーは地番の代表点をこの表から読む |
| `point_priority` | 代表点の種類・出典ごとの優先順位と、地価公示の標準地で計測した誤差 |

町字の表は `lg_code` の順、住居表示・地番の表は町字ごとのキーの順に並べてある。市区町村や町字で絞って読むと、Parquet のフッターの統計から当たる行グループだけを読めばよい。行グループの大きさは `dbt_project.yml` で決めている。座標は `geometry` ではなく `lng` / `lat` の数値の列で持つ。

## ビルド

```bash
git submodule update --init
uv sync
scripts/build.sh   # fdl checkout → dbt → fdl commit で公開まで行う
```

address_br の更新（毎月）の翌日に、`.github/workflows/sync.yml` が作り直す。
