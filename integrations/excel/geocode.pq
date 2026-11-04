// Power Query: 「住所」という名前のテーブル (列「住所」) を Queria Geocoder で変換する
let
    Source = Excel.CurrentWorkbook(){[Name = "住所"]}[Content],
    Addresses = List.Transform(Source[住所], each if _ = null then "" else Text.Trim(Text.From(_))),
    // 1 回の呼び出しに 25 件まで
    Post = (batch as list) as list =>
        Json.Document(
            Web.Contents(
                "https://geocoder.queria.io/v1/batch",
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
    // 空の行は送らず、結果を行の番号で元の行に戻す
    Indexed = Table.AddIndexColumn(Table.FromColumns({Addresses}, {"住所"}), "i", 0),
    Filled = Table.SelectRows(Indexed, each [住所] <> ""),
    Found = Table.FromColumns(
        {Filled[i], List.Combine(List.Transform(List.Split(Filled[住所], 25), Post))}, {"j", "結果"}
    ),
    Joined = Table.RemoveColumns(
        Table.Sort(Table.Join(Indexed, "i", Found, "j", JoinKind.LeftOuter), {"i"}), {"i", "j"}
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
