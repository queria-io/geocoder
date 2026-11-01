# Queria Geocoder

日本の住所を緯度・経度と地域コード（市区町村コード・国勢調査の小地域コード・地域メッシュコード）に変える、無料のジオコーダーです。地図上の点から住所を調べることもできます。登録はいりません。

- サイト: https://geocoder.queria.io/
- API の説明: https://geocoder.queria.io/docs
- API 仕様（OpenAPI）: https://geocoder.queria.io/openapi.json

```bash
curl -s -G https://geocoder.queria.io/v1/geocode --data-urlencode "address=東京都千代田区紀尾井町1-3"
```

## このリポジトリ

- 直下: ジオコーダーが読む表を作る Queria のデータセット `geocoder`（このページの以下）
- [`worker/`](worker/README.md): geocoder.queria.io を出す Cloudflare Worker（API・サイト・API の説明のページ）

ライセンスは [MIT](LICENSE)。住所の照合の規則は [abr-geocoder](https://github.com/digital-go-jp/abr-geocoder)（デジタル庁、MIT ライセンス）を元にしている（[`worker/upstream/`](worker/upstream/README.md)）。

## データセット

元にするのは Queria の公開データセット [address_br](https://github.com/queria-io/dataset-address-br)（アドレス・ベース・レジストリ）、e_stat（国勢調査の小地域境界）、nlftp（国交省の街区レベル位置参照情報）。取得はせず、それを読んで次の表を作る。

| 表 | 中身 |
|---|---|
| `town` | 町字の名前・別名・代表点と、代表点が入る小地域 |
| `rsdtdsp_blk` | 住居表示の街区（「○番」）の代表点 |
| `rsdtdsp_rsdt` | 住居表示の住居（「○号」）の代表点 |
| `parcel` | 地番の住所と代表点（座標の付く筆は一部だけ） |
| `isj_block` | 国交省の位置参照情報の街区・地番の親番の点を町字に付けたもの。ABR に座標の無い地番の住所に使う |

町字の表は `lg_code` の順、住居表示・地番の表は町字ごとのキーの順に並べてある。市区町村や町字で絞って読むと、Parquet のフッターの統計から当たる行グループだけを読めばよい。行グループの大きさは `dbt_project.yml` で決めている。座標は `geometry` ではなく `lng` / `lat` の数値の列で持つ。

## ビルド

```bash
git submodule update --init
uv sync
scripts/build.sh   # fdl checkout → dbt → fdl commit で公開まで行う
```

address_br の更新（毎月）の翌日に、`.github/workflows/sync.yml` が作り直す。
