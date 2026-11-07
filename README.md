# Queria Geocoder

日本の住所を緯度・経度と地域コード（市区町村コード・国勢調査の小地域コード・地域メッシュコード）に変える、無料のジオコーダーです。地図上の点から住所を調べることもできます。登録はいりません。

- API の説明: https://geocoder.queria.io/docs
- API 仕様（OpenAPI）: https://geocoder.queria.io/openapi.json
- 精度の比較と照合の規則: 日本の住所 1,420 件でほかの無料のジオコーダーと比較した結果と、Queria Geocoder の照合の規則（[BENCHMARK.md](BENCHMARK.md)）
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

「守山3-7-5」のように市区町村名を書かない住所は、町字の名前からその町字を持つ市区町村を探して照合する。候補にするのは、住所に書かれた町名・小字・丁目・番号（住居表示の街区符号か地番の本番）が最も深くまで実在する市区町村である（「天神1-8-35」なら、天神 1 丁目に 8 番がある市区町村）。候補が複数あるときは、座標の細かさの順（号・地番の点を持つ候補が先、町字の代表点しかない候補が後）、同じ細かさなら人口の多い順に並べて返し、各結果の `ambiguous` を `true`、`candidates` を候補の数にする。照合し直すのは人口の多い順に、`limit` の上限と同じ 10 の市区町村までで、それより多い候補は返さないが `candidates` には数える。

- `/v1/forward` と `/v1/forward/batch` は `limit` の数まで候補を返す（既定の `limit=1` では先頭の 1 件）。`/v1/forward/batch` は住所ごとに `/v1/forward` と同じ `{ "address", "results" }` を、渡した住所と同じ順・同じ数で返す
- 市区町村名のある住所でも、甲乙丙丁を書かない番号が甲乙丙丁だけ違う複数の地番に当たるとき（「甲288」と「乙288」があって「288」と書いた住所）は、すべてを候補として返し、`ambiguous` を `true` にする
- 市区町村名のない住所で `ambiguous` が `true` の結果は、市区町村を推定している。住所の地域がわかっている場合は、`prefecture_code`（都道府県コード 2 桁）か `city_code`（全国地方公共団体コード 5 桁か 6 桁）を付けると、その地域の結果だけを返す

## 統計データとの結合

`include=small_area` を付けると、国勢調査の小地域コード（`estat_small_area_code`）を返す。[Queria](https://queria.io) の公開データセットは同じコードで国勢調査の表を持っているので、SQL で結合できる。

```sql
-- 東京都千代田区紀尾井町1-3 の estat_small_area_code は 131010100
SELECT key_code, city_name, area_name, jinko, setai
FROM e_stat.boundary.small_area
WHERE key_code = '131010100'
```

## セルフホスト

自分の Cloudflare アカウントの Worker として動かせる。Node.js と pnpm があれば、次のコマンドでデプロイできる。

```bash
cd worker
pnpm install
npx wrangler login
pnpm self-host
```

`https://geocoder.<アカウントのサブドメイン>.workers.dev` で API が動く。データ (住所の表と境界タイル) は Queria が公開している `https://data.queria.io/geocoder/` と `https://assets.queria.io/boundaries/` から HTTP の Range で読むので、データのコピーもバケットも要らない。住所の表は Queria の毎月の更新にそのまま追従する。境界タイルは設定の `BOUNDARY_TILES_FILE` が指すファイルに固定されるので、新しい境界を使うときはこの値を書き換えてデプロイし直す。入力の住所や座標は Queria に送られない。ただし Queria はファイルのどの範囲が読まれたかを受け取り、そこから問い合わせた市区町村 (正引き) やおおよその位置 (逆引きのタイル) が分かる。これも避けるときは、下の自分の R2 に取り込む形にする。

設定は [`worker/wrangler.self-host.jsonc`](worker/wrangler.self-host.jsonc) にある。

- Queria に依存せずに動かすときは、R2 のバケットを作り (`npx wrangler r2 bucket create geocoder-data`)、設定の `r2_buckets` と `triggers` のコメントを外してデプロイし直す。毎日 1 回、新しいバージョンがあれば自分のバケットに取り込み (約 4GB)、そこから読む。取り込みが終わるまでは公開の URL から読む
- リクエストのログは記録しない。回数の上限 (IP ごと) も付けていない

## このリポジトリ

- 直下: ジオコーダーが読む表を作る Queria のデータセット `geocoder`（このページの以下）
- [`worker/`](worker/README.md): geocoder.queria.io を出す Cloudflare Worker（API と API の説明のページ）
- [`examples/addresses.csv`](examples/addresses.csv): `POST /v1/forward/batch` を試すための住所の CSV（役所などの住所と、郡や都道府県を省いたものなど書き方を変えたもの）

ライセンスは [MIT](LICENSE)。住所の照合の規則は [abr-geocoder](https://github.com/digital-go-jp/abr-geocoder)（デジタル庁、MIT ライセンス）を元にしている（[`worker/upstream/`](worker/upstream/README.md)）。

## データセット

元にするのは Queria の公開データセット [address_br](https://github.com/queria-io/dataset-address-br)（アドレス・ベース・レジストリ）、e_stat（国勢調査の小地域境界）、nlftp（国交省の街区・大字町丁目レベル位置参照情報）、codh（CODH の歴史的行政区域データセット）。取得はせず、それを読んで次の表を作る。

| 表 | 中身 |
|---|---|
| `town` | 町字の名前・別名・代表点と、代表点が入る小地域 |
| `town_name` | 町字ごとの名前・丁目・小字と、その町字にある番号（街区符号・地番の本番）の索引。市区町村名を書かない住所から、その住所を持つ市区町村を引くのに使う |
| `former_city` | 合併などで無くなった市区町村の名前から、その範囲を引き継いだ今の市区町村を引く索引。旧市区町村名で書いた住所の照合に使う |
| `rsdtdsp_blk` | 住居表示の街区（「○番」）の代表点 |
| `rsdtdsp_rsdt` | 住居表示の住居（「○号」）の代表点 |
| `parcel` | 地番の住所と代表点（座標の付く筆は一部だけ） |
| `isj_block` | 国交省の位置参照情報の街区・地番の親番の点を町字に付けたもの |
| `address_point_candidate` | 住所ごとの代表点の候補（出典ごとに 1 行） |
| `address_point` | 住所ごとに選択した代表点（代表点のある住所のみ。出典が複数あれば優先順位の高い 1 つ） |
| `point_priority` | 代表点の種類・出典ごとの優先順位と、地価公示の標準地で計測した誤差 |
| `match_area` | 住所の照合に使う区域の索引。大字・町、丁目、小字を連結した名前を、ABR と位置参照情報（過去の版を含む）の表記のまま持つ |
| `match_number` | 住所の照合に使う番号の索引のうち、町字の表に無い番号の点（番号を振る区域で引く地番、地番の親番、位置参照情報の街区・地番）。区域・番号・出典ごとに 1 行 |

町字・住居表示・地番の表と照合の索引（`town`・`rsdtdsp`・`parcel`・`match_area`・`match_number`）は、都道府県（`pref_code`）ごとにファイルを分けてある。ファイルの中は、町字の表と `match_area` は `lg_code` の順、住居表示・地番の表は町字ごとのキーの順、`match_number` は `area_id` の順に並べてある。市区町村や町字で絞って読むと、Parquet のフッターの統計から当たる行グループだけを読めばよい。行グループの大きさは `dbt_project.yml` で決めている。座標は `geometry` ではなく `lng` / `lat` の数値の列で持つ。

`town` の列のうち、照合の規則にかかわるものは次のとおり。

- `point_level`: 代表点の作り方。`town` は町字自身の代表点、`parent_town` は代表点の無い小字などに同じ大字・町の代表点を使ったもの、`oaza_mean` は大字・町にも代表点が無いときに同じ大字・町の小字などの代表点の平均、`isj_oaza` はそれも無いときに位置参照情報の大字・町丁目の点を名前で当てたもの、`address_mean` はそれも無いときにその町字の地番と街区・地番の親番の点の平均、`oaza_address_mean` は同じ大字・町の町字のそれの平均。どれも無い町字は NULL
- `has_chome`: この町字か同じ大字・町のどれかに丁目があれば true。町名のすぐ後の数字を丁目と読むかどうかに使う
- `numbering_id`: この町字の地番が振られている町字。小字が起番でなければ大字・町の町字 ID
- `parcel_unique`: `numbering_id` の町字の中で地番が 1 つに決まれば true。false は小字ごとに地番が振られた大字・町で、小字を省いた地番の住所は当てない
- `post_code`: ABR の町字マスタの値。無ければ japan_address_code の `town_postal_code` で町域名が一致し、町字に 1 つに決まる番号
- `small_area_code`: 代表点が入る国勢調査の小地域。町字と小地域は 1 対 1 ではない

`former_city` の `one_pref` が true の名前は、同じ名前の旧市区町村が 1 つの都道府県にしか無い。都道府県名の無い住所では true の名前だけを使う。

## ビルド

```bash
git submodule update --init
uv sync
scripts/build.sh   # fdl checkout → dbt → fdl commit で公開まで行う
```

address_br の更新（毎月）の翌日に、`.github/workflows/sync.yml` が作り直す。
