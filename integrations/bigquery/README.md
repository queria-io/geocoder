# BigQuery

BigQuery の関数から外部の API を呼べるのは、Cloud Run を呼び先にするリモート関数だけである。Queria が中継の Cloud Run を公開しているので、自分のプロジェクトでは接続と関数を作るだけで使える。

## 使い方

1. 接続を作る (データセットと同じリージョン)

   ```bash
   bq mk --connection --location=asia-northeast1 --connection_type=CLOUD_RESOURCE queria_geocoder
   ```

2. [`geocode.sql`](geocode.sql) の `PROJECT`・`DATASET`・`REGION`・`CONNECTION` を自分の値にし、`ENDPOINT` を中継の URL にして流す

   ```sql
   SELECT LAX_FLOAT64(g.lat) AS lat, LAX_FLOAT64(g.lng) AS lng, LAX_STRING(g.lg_code) AS lg_code
   FROM (SELECT `PROJECT.DATASET.geocode`(address) AS g FROM 表);
   ```

関数は住所ごとに、API の結果 1 件を JSON で返す (当たらなければ NULL)。BigQuery は行を 100 件ずつ中継に送り、中継は `/v1/batch` に 25 件ずつ渡す。

## 中継

[`main.py`](main.py) が中継のコード (Cloud Run functions)。自分のプロジェクトに置くときは次のようにデプロイし、接続のサービスアカウントに Cloud Run 起動元のロールを付ける。

```bash
gcloud functions deploy queria-geocode --gen2 --runtime=python312 --region=asia-northeast1 \
  --source=. --entry-point=geocode --trigger-http --max-instances=4
```
