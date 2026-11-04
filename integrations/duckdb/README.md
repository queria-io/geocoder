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

## 国勢調査の人口・世帯数を付ける

`small_area_code` は国勢調査の小地域 (町丁・字等) のコードで、Queria の e_stat の表と同じ体系になっている。e_stat を ATTACH すると、小地域の人口と世帯数を結合できる (令和2年国勢調査)。

```sql
INSTALL ducklake;
LOAD ducklake;
ATTACH 'ducklake:https://data.queria.io/e_stat/ducklake.duckdb' AS e_stat (READ_ONLY);

SELECT g.address, g.small_area_code, s.area_name, s.jinko AS population, s.setai AS households
FROM geocode(['東京都千代田区丸の内1-9-1', 'つくば市学園南3丁目28番10']) g
LEFT JOIN e_stat.boundary.small_area s ON s.key_code = g.small_area_code;
```

年齢別の人口や世帯の家族類型は e_stat の `census` スキーマの表にあり、`area = small_area_code` で同じように結合する。表の一覧は [Queria のデータセットのページ](https://queria.io/datasets/queria/e_stat) にある。値は住所の点が入る小地域のもので、町字の代表点しか分からない住所 (`coordinates_level` が `machiaza`) では代表点の入る小地域の値になる。
