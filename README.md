# geocoder

住所の文字列と座標・地域コードを相互に引くジオコーダー。

- 直下: ジオコーダーが読む表を作る Queria のデータセット `geocoder`（このページの以下）
- [`worker/`](worker/README.md): geocoder.queria.io を出す Cloudflare Worker（API・LP・説明のページ）

API・LP・試す画面は geocoder.queria.io で、このリポジトリから出す。queria-web はこの API をふつうの利用者と同じ形で呼ぶ。
queria-web との境目は、公開の API 仕様（OpenAPI）と、API キー・プランの確認の 2 つだけにする。

## データセット

元にするのは Queria の公開データセット [address_br](https://github.com/queria-io/dataset-address-br)（アドレス・ベース・レジストリ）、e_stat（国勢調査の小地域境界）、nlftp（国交省の街区レベル位置参照情報）。取得はせず、それを読んで次の表を作る。

| 表 | 中身 |
|---|---|
| `town` | 町字の名前・別名・代表点と、代表点が入る小地域 |
| `rsdtdsp_blk` | 住居表示の街区（「○番」）の代表点 |
| `rsdtdsp_rsdt` | 住居表示の住居（「○号」）の代表点 |
| `parcel` | 地番の住所と代表点（座標の付く筆は一部だけ） |
| `isj_block` | 国交省の位置参照情報の街区・地番の親番の点を町字に付けたもの。ABR に座標の無い地番の住所に使う |

どの表も `lg_code` の順に並べ、行グループを 30,720 行（DuckDB の並列書き込みの単位 122,880 行の 4 分の 1）にしてある。市区町村で絞って読むと、Parquet のフッターの統計から 1〜2 個の行グループだけを読めばよい。座標は `geometry` ではなく `lng` / `lat` の数値の列で持つ。

## ビルド

```bash
git submodule update --init
uv sync
scripts/build.sh   # queria sync で公開まで行う
```

address_br の更新（毎月）の翌日に、`.github/workflows/sync.yml` が作り直す。
