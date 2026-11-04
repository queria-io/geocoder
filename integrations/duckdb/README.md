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

返る行は入力の順ではないので、元の表とは `address` で結合する。同じ住所は 1 行にまとめ、空の住所と 100 文字を超える住所は除く。照合できない住所は、住所以外の列が NULL の行になる。API がエラーを返した住所が 1 つでもあると (回数の上限を超えたときなど)、問い合わせ全体が失敗する。

1 住所ごとに 1 回 API を呼ぶ。1 分に 300 回の上限があるので、1 回に渡すのは 300 件までにする。
