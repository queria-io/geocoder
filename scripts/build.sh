#!/usr/bin/env bash
set -euo pipefail
# 上流のデータセットは、ビルドを始めたときのバージョンのカタログを読む (profiles.yml)
eval "$("$(dirname "$0")/pin-upstream.sh")"
exec "$(dirname "$0")/../shared/scripts/build-fdl.sh" "$@"
