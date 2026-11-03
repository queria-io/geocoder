# CLAUDE.md

Queria のジオコーダー。住所と座標・地域コードを相互に引く。データとロジックを 1 つのリポジトリに置き、
同じ PR で一緒に直す。

- 直下: ジオコーダーが読む表を作る dbt のデータセット (Queria の `geocoder`)。address_br・e_stat・nlftp を読んで
  lg_code 順の Parquet にする (行グループは町字の表が 4,096 行、ほかは 30,720 行)。毎月 `.github/workflows/sync.yml` が作り直す
- `worker/`: Cloudflare Workers の API。DuckDB もデータベースも使わない。逆引き (`/v1/reverse`) は R2 の境界 PMTiles、
  正引き (予定) は直下のデータセットの Parquet を Range で読む

直すときは [DESIGN.md](DESIGN.md) の 5 つの観点（精度・速さ・メモリ・データの形・説明しやすさ）で確かめ、PR に書く。

表の列・並び・行グループは `worker/` の読み方に合わせて決めている。片方だけ変えない。

`worker/` は DuckLake のカタログを読まず、DuckLake が書いた Parquet を直接読む。そのために守ること:

- 表は毎回まるごと作り直す (`materialized='table'`)。incremental にすると DuckLake が削除ファイルを持ち、
  Parquet だけを読む `worker/` が消したはずの行まで返す
- `worker/` が読むファイルは FDL の `refs/heads/main` が指すバージョンで決める。古いバージョンのファイルは
  保持期間を過ぎると消えるので、作り直したら必ず指す先を切り替える

## queria-web との境目

- このリポジトリが出すのは API (geocoder.queria.io/v1) と仕様書 (/docs・/openapi.json) だけ。`/` は /docs へ転送する。queria-web へは転送しない (このリポジトリだけで成り立つようにする)
- queria-web (エリア分析など) はこの API をふつうの利用者と同じ形で呼ぶ。ログインと API キーは queria.io 側
- つながりは公開の API 仕様 (OpenAPI) と、API キーの確認の 2 本だけ。queria-web の D1 の表や画面の部品をこれ以上読まない
- API の形を変えるときは OpenAPI の差分として PR に出す。アカウントと利用規約は Queria のものを使う

## コマンド

```bash
# データセット (直下)
uv sync
scripts/build.sh            # dbt で作って fdl commit

# API (worker/、パッケージマネージャーは pnpm)
cd worker
pnpm test                   # vitest (Workers ランタイム)
pnpm typecheck
pnpm check                  # oxlint + oxfmt --check
```

## abr-geocoder の取り込み

住所の正規化はデジタル庁の abr-geocoder の写し。手順は `worker/upstream/README.md`。

- `worker/src/normalize/` は上流の `abrg/internal/normalize/` と同じファイル名・規則名・順番を保つ。こちらの都合で並べ替えない
- 上流の試験は `worker/upstream/cases.json` をそのまま流す。試験を書き直さない
- 毎週月曜に定期の作業が上流の差分と issue を見て、取り込みの PR を作る

## 変更の出し方

`main` への直接コミットはしない。PR にして出し、マージは人間が行う。コミットメッセージは Conventional Commits。
