# Excel

## Power Query (Windows・Mac の Microsoft 365)

1. 住所の表を選び、「挿入」→「テーブル」でテーブルにする。テーブル名を「住所」、住所の列名を「住所」にする
2. 「データ」→「データの取得」→「その他のデータソースから」→「空のクエリ」を開く
3. 「詳細エディター」に [`geocode.pq`](geocode.pq) の中身を貼り付けて「完了」を押し、「閉じて読み込む」を押す

住所ごとに、緯度・経度・照合レベル・全国地方公共団体コード・町字 ID・郵便番号・小地域コードの列が付いた表ができる。25 件ずつまとめて送るので、件数が多くても回数の上限に当たりにくい。住所を足したら「すべて更新」を押す。

## WEBSERVICE 関数 (Windows の Microsoft 365)

A2 の住所の結果を、横に並べて返す。

```
=TEXTSPLIT(INDEX(TEXTSPLIT(WEBSERVICE("https://geocoder.queria.io/v1/geocode?format=csv&include=codes&address="&ENCODEURL(A2)),,CHAR(10)),2),",")
```

1 セルごとに 1 回 API を呼ぶ。数百行を超えるときは Power Query を使う。WEBSERVICE 関数は Mac 版と Web 版の Excel には無い。
