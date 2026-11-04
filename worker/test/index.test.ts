import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { contains, tilePoint } from "../src/lookup";
// 東京駅の入るタイルにだけ形を置いた PMTiles (test/make-fixture.py)
import fixture from "./fixture.pmtiles";

const BASE = "https://geocoder.test/v1/reverse";

/** z13 のタイル (7276, 3225) の中の位置 (0〜1) を経緯度に戻す */
const at = (fx: number, fy: number) => {
  const n = 2 ** 13;
  const lng = ((7276 + fx) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (3225 + fy)) / n))) * 180) / Math.PI;
  return `lat=${lat}&lng=${lng}`;
};

const reverse = async (query: string) => {
  const response = await exports.default.fetch(`${BASE}?${query}`);
  return { status: response.status, body: await response.json() };
};

beforeAll(async () => {
  await env.BUCKET.put(`boundaries/${env.BOUNDARY_TILES_FILE}`, fixture);
});

describe("tilePoint", () => {
  it("東京駅は z13 の (7276, 3225)", () => {
    const t = tilePoint(139.7671, 35.6812, 13);
    expect([t.x, t.y]).toEqual([7276, 3225]);
  });

  it("メルカトルの範囲外の緯度は端のタイルに寄せる", () => {
    // 寄せないと y が負になり、zxyToTileId が日本のタイルの番号を返す
    expect(tilePoint(127.65, 89.87, 13).y).toBe(0);
    expect(tilePoint(127.65, -89.87, 13).y).toBe(2 ** 13 - 1);
  });
});

describe("contains", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const hole = [
    { x: 4, y: 4 },
    { x: 6, y: 4 },
    { x: 6, y: 6 },
    { x: 4, y: 6 },
  ];
  it("穴の中は外", () => {
    expect(contains([square, hole], { x: 2, y: 2 })).toBe(true);
    expect(contains([square, hole], { x: 5, y: 5 })).toBe(false);
    expect(contains([square], { x: 11, y: 5 })).toBe(false);
  });
});

describe("/v1/reverse", () => {
  it("町丁目に入る点は 3 つのコードを返す", async () => {
    const { status, body } = await reverse(at(0.25, 0.75));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      lg_code: "131016",
      estat_small_area_code: "131010010",
      match_level: "small_area",
      source: { version: env.BOUNDARY_TILES_FILE.replace(".pmtiles", "") },
    });
    expect(body).not.toHaveProperty("codes");
  });

  it("include=codes でコードとメッシュを足す", async () => {
    const { body } = await reverse(`${at(0.25, 0.75)}&include=codes`);
    expect(body).toMatchObject({ codes: { prefecture_code: "13", city_code: "13101" } });
  });

  it("include=address は町字の表を読む (この試験の R2 には無いので 502)", async () => {
    const { status } = await reverse(`${at(0.25, 0.75)}&include=address`);
    expect(status).toBe(502);
  });

  it("知らない include は 400", async () => {
    const { status } = await reverse(`${at(0.25, 0.75)}&include=parts`);
    expect(status).toBe(400);
  });

  it("町丁目の穴の中は市区町村まで", async () => {
    const { body } = await reverse(at(0.18, 0.18));
    expect(body).toMatchObject({
      lg_code: "131016",
      estat_small_area_code: null,
      match_level: "city",
    });
  });

  it("町丁目の外 (タイルの右半分) も市区町村まで", async () => {
    const { body } = await reverse(at(0.75, 0.5));
    expect(body).toMatchObject({ lg_code: "131016", estat_small_area_code: null });
  });

  it("形の無いところは全部 null", async () => {
    const { body } = await reverse("lat=34.7&lng=135.5");
    expect(body).toMatchObject({
      lg_code: null,
      estat_small_area_code: null,
      match_level: null,
      source: { attribution: [] },
    });
  });

  it.each(["", "lat=35", "lat=abc&lng=139", "lat=95&lng=139"])(
    "座標がおかしい %s は 400",
    async (q) => {
      const { status } = await reverse(q);
      expect(status).toBe(400);
    },
  );

  it("ほかのパスは 404", async () => {
    const response = await exports.default.fetch("https://geocoder.test/v1/forward");
    expect(response.status).toBe(404);
  });

  it("GET 以外は 405", async () => {
    const response = await exports.default.fetch(BASE, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("どこからでも呼べる", async () => {
    const response = await exports.default.fetch(`${BASE}?${at(0.25, 0.75)}`);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/v1/batch", () => {
  const post = (body: unknown) =>
    exports.default.fetch("https://geocoder.test/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("26 件以上は 400 で、上限の件数を返す", async () => {
    const response = await post({ addresses: Array.from({ length: 26 }, () => "東京") });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("1〜25 件");
  });

  it("GET は 405", async () => {
    const response = await exports.default.fetch("https://geocoder.test/v1/batch");
    expect(response.status).toBe(405);
  });
});

describe("/", () => {
  it("/ は仕様書へ転送する", async () => {
    const response = await exports.default.fetch("https://geocoder.test/", { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/docs");
  });
});

describe("/docs", () => {
  it("仕様書を読む HTML を返す", async () => {
    const response = await exports.default.fetch("https://geocoder.test/docs");
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain('data-url="/openapi.json"');
  });
});

describe("/openapi.json", () => {
  it("逆引きと正引きの仕様を返す", async () => {
    const response = await exports.default.fetch("https://geocoder.test/openapi.json");
    const doc = (await response.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(["/v1/reverse", "/v1/geocode", "/v1/batch"]);
  });

  it("逆引きの lat・lng は数値として書く", async () => {
    const response = await exports.default.fetch("https://geocoder.test/openapi.json");
    const doc = (await response.json()) as {
      paths: {
        "/v1/reverse": { get: { parameters: { name: string; schema: { type: string } }[] } };
      };
    };
    const types = doc.paths["/v1/reverse"].get.parameters
      .filter((p) => p.name !== "include")
      .map((p) => [p.name, p.schema.type]);
    expect(types).toEqual([
      ["lat", "number"],
      ["lng", "number"],
    ]);
  });
});

describe("/v1/geocode", () => {
  it("知らない include や format は 400", async () => {
    const base = "https://geocoder.test/v1/geocode?address=%E6%9D%B1%E4%BA%AC";
    expect((await exports.default.fetch(`${base}&include=foo`)).status).toBe(400);
    expect((await exports.default.fetch(`${base}&format=xml`)).status).toBe(400);
  });

  it("limit が範囲外なら 400", async () => {
    const response = await exports.default.fetch(
      "https://geocoder.test/v1/geocode?address=%E6%9D%B1%E4%BA%AC&limit=11",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "limit は 1〜10 の整数で渡してください" });
  });

  it("prefecture_code・city_code の形が違えば 400", async () => {
    const base = "https://geocoder.test/v1/geocode?address=%E6%9D%B1%E4%BA%AC";
    for (const q of ["prefecture_code=1", "city_code=2520"]) {
      const response = await exports.default.fetch(`${base}&${q}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "prefecture_code は 2 桁、city_code は 5 桁か 6 桁の数字で渡してください",
      });
    }
  });

  it("住所が空なら 400", async () => {
    const response = await exports.default.fetch("https://geocoder.test/v1/geocode?address=%20");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "address を 1〜100 文字で渡してください" });
  });
});
