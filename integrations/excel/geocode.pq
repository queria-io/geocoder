// Power Query: 「住所」という名前のテーブル (列「住所」) を Queria Geocoder で変換する
let
    Source = Excel.CurrentWorkbook(){[Name = "住所"]}[Content],
    // 1 回の呼び出しに 25 件まで。API は住所と同じ順・同じ数で返し、空の住所は結果が空になる
    Post = (batch as list) as list =>
        List.Transform(
            Json.Document(
                Web.Contents(
                    "https://geocoder.queria.io/v1/forward/batch",
                    [
                        Headers = [#"Content-Type" = "application/json"],
                        Content = Json.FromValue(
                            [
                                addresses = batch,
                                include = "ids,codes,small_area"
                            ]
                        )
                    ]
                )
            )[results],
            each List.First([results], null)
        ),
    Addresses = List.Transform(Source[住所], each if _ = null then "" else Text.Trim(Text.From(_))),
    // 結果を 1 度だけ読む (遅延評価で API を呼び直さない)。元のテーブルのほかの列はそのまま残す
    Found = List.Buffer(List.Combine(List.Transform(List.Split(Addresses, 25), Post))),
    Joined = Table.FromColumns(
        Table.ToColumns(Source) & {Found}, Table.ColumnNames(Source) & {"結果"}
    ),
    Expanded = Table.ExpandRecordColumn(
        Joined, "結果",
        {"lat", "lng", "match_level", "lg_code", "ids", "codes", "estat_small_area_code"},
        {"緯度", "経度", "照合レベル", "全国地方公共団体コード", "ids", "codes", "小地域コード"}
    ),
    WithIds = Table.ExpandRecordColumn(Expanded, "ids", {"machiaza_id"}, {"町字ID"}),
    WithCodes = Table.ExpandRecordColumn(WithIds, "codes", {"postal_code"}, {"郵便番号"})
in
    WithCodes
