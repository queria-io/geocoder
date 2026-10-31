# CLAUDE.md

Queria のジオコーダー API。Cloudflare Workers で動き、DuckDB もデータベースも使わない。
逆引き (`/v1/reverse`) は R2 の境界 PMTiles を Range で読む。正引きはまだ無く、dataset-geocoder が作る Parquet を Range で読む予定。

## コマンド

パッケージマネージャーは pnpm。

```bash
pnpm test        # vitest (Workers ランタイム)
pnpm typecheck
pnpm check       # oxlint + oxfmt --check
```

## abr-geocoder の取り込み

住所の正規化はデジタル庁の abr-geocoder の写し。手順は `upstream/README.md`。

- `src/normalize/` は上流の `abrg/internal/normalize/` と同じファイル名・規則名・順番を保つ。こちらの都合で並べ替えない
- 上流の試験は `upstream/cases.json` をそのまま流す。試験を書き直さない
- 毎週月曜に定期の作業が上流の差分と issue を見て、取り込みの PR を作る

## 変更の出し方

`main` への直接コミットはしない。PR にして出し、マージは人間が行う。コミットメッセージは Conventional Commits。
