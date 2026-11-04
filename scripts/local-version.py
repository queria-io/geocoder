"""作業場のカタログを、Worker が読める FDL のリポジトリの形で手元に書き出す (精度チェック用)。

使い方: uv run python scripts/local-version.py <作業場のカタログ> <書き出す先>

書き出す先は fdl checkout がデータファイルを書くフォルダ。そこに fdl.json・refs/heads/main・
versions/pr/ を置く。files.json のパスは、作り直した表が書き出す先からの相対パス、
作り直していない表が本番のファイルの URL (checkout が絶対パスにしたもの) になる。
"""

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

LIVE = "end_snapshot IS NULL"


def table_files(con: sqlite3.Connection) -> dict[str, dict]:
    rows = con.execute(
        f"""
        SELECT s.schema_name || '.' || t.table_name,
               CASE WHEN f.path_is_relative
                    THEN coalesce(s.path, '') || coalesce(t.path, '') || f.path
                    ELSE f.path END,
               EXISTS (SELECT 1 FROM ducklake_delete_file d
                       WHERE d.data_file_id = f.data_file_id AND d.{LIVE})
        FROM ducklake_data_file f
        JOIN ducklake_table t ON t.table_id = f.table_id AND t.{LIVE}
        JOIN ducklake_schema s ON s.schema_id = t.schema_id AND s.{LIVE}
        WHERE f.{LIVE}
        ORDER BY 1, f.file_order, f.data_file_id
        """
    ).fetchall()
    tables: dict[str, dict] = {}
    for name, path, deleted in rows:
        tables.setdefault(name, {"files": []})["files"].append(
            {"path": path, **({"deletes": True} if deleted else {})}
        )
    return tables


def main(working: str, out: str) -> None:
    root = Path(out)
    with sqlite3.connect(working) as con:
        tables = table_files(con)
    version = root / "versions" / "pr"
    version.mkdir(parents=True, exist_ok=True)
    (root / "refs" / "heads").mkdir(parents=True, exist_ok=True)
    (root / "fdl.json").write_text(json.dumps({"data_dir": ""}))
    (root / "refs" / "heads" / "main").write_text("pr\n")
    created = datetime.now(timezone.utc).isoformat()
    (version / "version.json").write_text(json.dumps({"id": "pr", "created_at": created}))
    (version / "files.json").write_text(json.dumps({"tables": tables}, ensure_ascii=False, indent=2))
    for name, table in tables.items():
        local = sum(not f["path"].startswith("https://") for f in table["files"])
        print(f"{name}: {len(table['files'])} files ({local} rebuilt)")


if __name__ == "__main__":
    main(*sys.argv[1:])
