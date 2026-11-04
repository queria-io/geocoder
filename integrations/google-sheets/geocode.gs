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
  const results = [];
  // 1 回の呼び出しに 25 件まで
  for (let i = 0; i < list.length; i += 25) results.push(...post(list.slice(i, i + 25)));
  return results.map((r, i) =>
    list[i] === "" || r === null
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

function post(addresses) {
  const response = UrlFetchApp.fetch("https://geocoder.queria.io/v1/batch", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      addresses: addresses.map((a) => a || "-"),
      include: "ids,codes,small_area",
    }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200)
    throw new Error("Queria Geocoder: " + response.getResponseCode() + " " + response.getContentText());
  return JSON.parse(response.getContentText()).results;
}
