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

返る行は入力の順ではないので、元の表とは `address` で結合する。同じ住所は 1 行にまとめる。照合できない住所 (空や 100 文字を超える住所を含む) は、住所以外の列が NULL の行になる。市区町村名のない住所で、同じ町名の市区町村が複数あるときは、先頭の候補（座標の点が細かい候補、次に人口の多い市区町村）を返し、`ambiguous` を true、`candidates` を候補の数にする。API がエラーを返した呼び出しが 1 つでもあると (回数の上限を超えたときなど)、問い合わせ全体が失敗する。

GET の `/v1/forward/batch` で 10 件ずつまとめて送る。1 分に 300 回の上限があるので、1 回に渡すのは 3,000 件までにする。
