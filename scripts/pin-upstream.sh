#!/usr/bin/env bash
# profiles.yml が読む上流のデータセットごとに、いま main が指すバージョンのカタログの URL を
# UPSTREAM_<エイリアス> として export する文を出す。ビルドの前に eval "$(scripts/pin-upstream.sh)" で使う。
# バージョンのカタログは後から変わらないので、ビルドの途中で上流が新しいバージョンを出しても同じカタログを読み続ける
set -euo pipefail

for name in address_br e_stat nlftp japan_address_code codh; do
    url="$(uv run fdl url "https://data.queria.io/datasets/queria/$name/")"
    echo "export UPSTREAM_$(echo "$name" | tr '[:lower:]' '[:upper:]')=$url"
done
