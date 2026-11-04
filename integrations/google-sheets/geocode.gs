/**
 * 住所を Queria Geocoder で緯度・経度と地域コードにする。
 * 例: =GEOCODE(A2:A100) で、行ごとに 緯度・経度・照合レベル・市区町村コード・町字 ID・郵便番号・小地域コード を返す
 *
 * @param {string|string[][]} addresses 住所のセルか範囲
 * @return 結果の表
 * @customfunction
 */
function GEOCODE(addresses) {
  const list = (Array.isArray(addresses) ? addresses : [[addresses]]).map((row) =>
    String(row[0] ?? "").trim(),
  );
  // 1 回の呼び出しに 25 件まで。API は住所と同じ順・同じ数で返し、空のセルは結果が空になる
  const chunks = [];
  for (let i = 0; i < list.length; i += 25) chunks.push(list.slice(i, i + 25));
  // カスタム関数は 30 秒で打ち切られるので、まとめた呼び出しは並べて送る
  const responses = chunks.length === 0 ? [] : UrlFetchApp.fetchAll(chunks.map(request));
  return responses.flatMap(parse).map(({ results: [r] }) =>
    r === undefined
      ? ["", "", "", "", "", "", ""]
      : [
          r.lat,
          r.lng,
          r.match_level,
          r.codes?.city_code ?? "",
          r.ids?.machiaza_id ?? "",
          r.codes?.postal_code ?? "",
          r.estat_small_area_code ?? "",
        ],
  );
}

function request(addresses) {
  return {
    url: "https://geocoder.queria.io/v1/forward/batch",
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      addresses,
      include: "ids,codes,small_area",
    }),
    muteHttpExceptions: true,
  };
}

function parse(response) {
  if (response.getResponseCode() !== 200)
    throw new Error("Queria Geocoder: " + response.getResponseCode() + " " + response.getContentText());
  return JSON.parse(response.getContentText()).results;
}
