"""作業場のカタログの表のファイルを、Worker が読む目録 (geocoder.json) にして手元に書き出す (精度チェック用)。

使い方: uv run python scripts/local-version.py <作業場のカタログ> <書き出す先>

書き出す先は fdl clone がデータファイルを書くフォルダ。目録のパスは、作り直した表が書き出す先からの相対パス、
作り直していない表が本番のファイルの URL (clone が絶対パスにしたもの) になる。
Worker の DATA_SOURCE を geocoder.json にすると、この目録から読む (worker/src/data/source.ts)。
"""

import json
import sqlite3
import sys
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


TABLES = Path(__file__).parent.parent / "worker" / "src" / "data" / "tables.json"


def main(working: str, out: str) -> None:
    with sqlite3.connect(working) as con:
        tables = table_files(con)
    for name, table in tables.items():
        if any(f.get("deletes") for f in table["files"]):
            raise SystemExit(f"{name} has deletes")
        local = sum(not f["path"].startswith("https://") for f in table["files"])
        print(f"{name}: {len(table['files'])} files ({local} rebuilt)")
    names = json.loads(TABLES.read_text())
    manifest = {
        "version": "pr",
        "tables": {
            worker: [f["path"] for f in tables.get(fdl, {"files": []})["files"]] for worker, fdl in names.items()
        },
    }
    (Path(out) / "geocoder.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
