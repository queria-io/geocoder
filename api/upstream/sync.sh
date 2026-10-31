#!/usr/bin/env bash
#
# abr-geocoder (デジタル庁、MIT) の試験を upstream/cases.json に抜き出し直し、前回の取り込み
# (upstream/UPSTREAM) から今回までに、写している部分の上流で何が変わったかを出す。
#
#   upstream/sync.sh            # 上流の main の先頭まで
#   upstream/sync.sh <commit>   # 指定のコミットまで
#
# 出た差分を見て src/normalize などの写しを直し、pnpm test が通ったら UPSTREAM ごとコミットする。
# 必要なもの: git、go
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="${TMPDIR:-/tmp}/abr-geocoder"
ref="${1:-origin/main}"
# 写している上流のディレクトリ。名寄せ (matching) は写さず、issue の試験だけを使う
paths=(abrg/internal/normalize abrg/internal/transform abrg/internal/util abrg/internal/matching)

if [ -d "$work/.git" ]; then
  git -C "$work" fetch -q origin
else
  git clone -q https://github.com/digital-go-jp/abr-geocoder "$work"
fi
git -C "$work" checkout -q "$ref"
previous="$(cat "$here/UPSTREAM")"
current="$(git -C "$work" rev-parse HEAD)"

# 抜き出しが途中で落ちても前回の cases.json を空にしないよう、いったん別のファイルに書く
(cd "$here/.." && go run ./upstream/extract/main.go "$work") > "$here/cases.json.tmp"
mv "$here/cases.json.tmp" "$here/cases.json"
# リポジトリの整形 (oxfmt) に合わせておき、取り込みの差分を試験の中身だけにする
(cd "$here/.." && pnpm exec oxfmt upstream/cases.json > /dev/null)
cp "$work/LICENSE" "$here/LICENSE"
echo "$current" > "$here/UPSTREAM"

echo "== $previous..$current"
git -C "$work" log --oneline "$previous..$current" -- "${paths[@]}"
git -C "$work" diff --stat "$previous..$current" -- "${paths[@]}"
