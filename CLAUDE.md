# CLAUDE.md

Queria のジオコーダー。住所と座標・地域コードを相互に引く。データとロジックを 1 つのリポジトリに置き、
同じ PR で一緒に直す。

- 直下: ジオコーダーが読む表を作る dbt のデータセット (Queria の `geocoder`)。address_br・e_stat・nlftp を読んで
  lg_code 順の Parquet にする (行グループは町字の表が 4,096 行、ほかは 30,720 行)。毎月 `.github/workflows/sync.yml` が作り直す
- `worker/`: Cloudflare Workers の API。DuckDB もデータベースも使わない。逆引き (`/v1/reverse`) は R2 の境界 PMTiles、
  正引き (予定) は直下のデータセットの Parquet を Range で読む

改修では [DESIGN.md](DESIGN.md) の 5 つの観点（精度・処理速度・メモリ使用量・データモデル・説明可能性）で影響を確認し、PR に記載する。

表の列・並び・行グループは `worker/` の読み方に合わせて決めている。片方だけ変えない。

`worker/` は DuckLake のカタログを読まず、DuckLake が書いた Parquet を直接読む。そのために守ること:

- 表は毎回まるごと作り直す (`materialized='table'`)。incremental にすると DuckLake が削除ファイルを持ち、
  Parquet だけを読む `worker/` が消したはずの行まで返す
- `worker/` が読むファイルは FDL の `refs/heads/main` が指すバージョンで決める。古いバージョンのファイルは
  保持期間を過ぎると消えるので、作り直したら必ず指す先を切り替える

## 文書の書き方

README・BENCHMARK.md・DESIGN.md・PR 本文・コメントは、技術文書として一般的な用語で書く。言い換えのための平易な和語や造語を使わない。

- 使う: 比較、比較方法、評価指標、回答率、照合、再照合、代表点、出典、優先順位、処理速度、応答時間、メモリ使用量、データモデル、結合キー、説明可能性、検証方法、ベンチマーク、精度チェック、今後の改善点
- 使わない: 比べ、比べ方、答えあり、当て直し、物差し、関門、出どころ、つなぎ方、確かめ方、速さ、データの形、まだ届いていないところ、次に直すところ
- PR 本文には変更内容と検証方法を書く

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
本番 (geocoder.queria.io) に出るのは production ブランチへのマージ。main → production のリリース PR は merge commit でマージする (`worker/README.md` のデプロイ)。
