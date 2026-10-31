# geocoder

住所の文字列と座標・地域コードを相互に引くジオコーダー。

- 直下: ジオコーダーが読む表を作る Queria のデータセット `geocoder`（このページの以下）
- [`api/`](api/README.md): その表と境界タイルを読む API（Cloudflare Workers）

API は geocoder.queria.io で出す。試せる画面（LP とデモ）は queria-web が queria.io/geocoder に置き、この API をふつうの利用者と同じ形で呼ぶ。画面のコードはこのリポジトリに置かない。
queria-web との境目は、公開の API 仕様（OpenAPI）と、API キー・プランの確認の 2 つだけにする。

## データセット

元にするのは Queria の公開データセット [address_br](https://github.com/queria-io/dataset-address-br)（アドレス・ベース・レジストリ）と e_stat（国勢調査の小地域境界）。取得はせず、それを読んで次の表を作る。

| 表 | 中身 |
|---|---|
| `town` | 町字の名前・別名・代表点と、代表点が入る小地域 |
| `rsdtdsp_blk` | 住居表示の街区（「○番」）の代表点 |
| `rsdtdsp_rsdt` | 住居表示の住居（「○号」）の代表点 |

どの表も `lg_code` の順に並べ、行グループを 30,720 行（DuckDB の並列書き込みの単位 122,880 行の 4 分の 1）にしてある。市区町村で絞って読むと、Parquet のフッターの統計から 1〜2 個の行グループだけを読めばよい。座標は `geometry` ではなく `lng` / `lat` の数値の列で持つ。

## ビルド

```bash
git submodule update --init
uv sync
scripts/build.sh   # queria sync で公開まで行う
```

address_br の更新（毎月）の翌日に、`.github/workflows/sync.yml` が作り直す。
