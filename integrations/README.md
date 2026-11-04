# 他のツールから使う

SQL やスプレッドシートの関数から Queria Geocoder を呼ぶためのコードと手順。どれも API (`https://geocoder.queria.io`) をそのまま呼ぶ。

| ツール | 置き場 | 使い方 |
|---|---|---|
| DuckDB | [`duckdb/`](duckdb/) | `SELECT * FROM geocode(['住所', ...])` |
| BigQuery | [`bigquery/`](bigquery/) | `SELECT dataset.geocode(address) FROM 表` |
| Google スプレッドシート | [`google-sheets/`](google-sheets/) | `=GEOCODE(A2:A100)` |
| Excel | [`excel/`](excel/) | Power Query のクエリ、または WEBSERVICE 関数 |

1 つの IP アドレスから 1 分に 300 回までに制限している。どの方法も、件数が多いときは `/v1/batch` で 25 件ずつまとめて送る。結果を公開するときは、レスポンスの `source.attribution` の出典も表示する。
