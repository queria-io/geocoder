# DuckDB

[`geocode.sql`](geocode.sql) を流すと、住所の一覧を受け取るテーブルマクロ `geocode` ができる。

```sql
.read geocode.sql
SELECT * FROM geocode(['東京都千代田区紀尾井町1-3', 'つくば市学園南3丁目28番10']);
```

表の列から渡すときは、一覧を変数に入れてから渡す。

```sql
SET VARIABLE addresses = (SELECT list(address) FROM 表);
SELECT * FROM geocode(getvariable('addresses'));
```

1 住所ごとに 1 回 API を呼ぶ。1 分に 300 回の上限があるので、1 回に渡すのは 300 件までにする。
