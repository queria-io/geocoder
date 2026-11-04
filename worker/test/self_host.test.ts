import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { httpBucket, withFallback } from "../src/self_host/http";
import { mirror } from "../src/self_host/mirror";

/** 公開のデータの代わり。キーと中身の表から get・head を返す */
const origin = (files: Record<string, string>): R2Bucket =>
  ({
    get: async (key: string) => {
      const body = files[key];
      if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body);
      return Object.assign(new Response(bytes), { size: bytes.byteLength });
    },
    head: async (key: string) =>
      files[key] === undefined ? null : { size: new TextEncoder().encode(files[key]).byteLength },
  }) as unknown as R2Bucket;

const version = (id: string, paths: string[]) => ({
  [`geocoder/versions/${id}/version.json`]: JSON.stringify({
    id,
    created_at: "2026-11-04T00:00:00Z",
  }),
  [`geocoder/versions/${id}/files.json`]: JSON.stringify({
    tables: { "town.town": { files: paths.map((path) => ({ path })) } },
  }),
  ...Object.fromEntries(paths.map((p) => [`geocoder/data/${p}`, `parquet ${p}`])),
});

const repo = (id: string, versions: Record<string, string>) => ({
  "geocoder/fdl.json": JSON.stringify({ data_dir: "data/" }),
  "geocoder/refs/heads/main": id + "\n",
  ...versions,
});

const text = async (key: string) => (await env.DATA.get(key))?.text();

describe("mirror", () => {
  afterEach(async () => {
    const all = await env.DATA.list({ prefix: "geocoder/" });
    await env.DATA.delete(all.objects.map((o) => o.key));
  });

  it("最新のバージョンを写し、refs/heads/main を最後に書く", async () => {
    const r = await mirror(
      origin(repo("v1", version("v1", ["town/a.parquet"]))),
      env.DATA,
      "geocoder/",
    );
    expect(r).toEqual({ version: "v1", copied: 1, deleted: 0 });
    expect(await text("geocoder/data/town/a.parquet")).toBe("parquet town/a.parquet");
    expect(await text("geocoder/refs/heads/main")).toBe("v1\n");
  });

  it("同じバージョンなら何もしない", async () => {
    const o = origin(repo("v1", version("v1", ["town/a.parquet"])));
    await mirror(o, env.DATA, "geocoder/");
    expect(await mirror(o, env.DATA, "geocoder/")).toEqual({
      version: "v1",
      copied: 0,
      deleted: 0,
    });
  });

  it("今と 1 つ前のバージョンのファイルだけを残す", async () => {
    const v1 = version("v1", ["town/a.parquet"]);
    const v2 = version("v2", ["town/b.parquet"]);
    const v3 = version("v3", ["town/c.parquet"]);
    await mirror(origin(repo("v1", v1)), env.DATA, "geocoder/");
    await mirror(origin(repo("v2", { ...v1, ...v2 })), env.DATA, "geocoder/");
    const r = await mirror(origin(repo("v3", { ...v1, ...v2, ...v3 })), env.DATA, "geocoder/");
    expect(r).toEqual({ version: "v3", copied: 1, deleted: 1 });
    expect(await env.DATA.head("geocoder/data/town/a.parquet")).toBeNull();
    expect(await text("geocoder/data/town/b.parquet")).toBe("parquet town/b.parquet");
    expect(await text("geocoder/data/town/c.parquet")).toBe("parquet town/c.parquet");
  });

  it("新しいバージョンを写すときは fdl.json も書き直す", async () => {
    await mirror(origin(repo("v1", version("v1", ["town/a.parquet"]))), env.DATA, "geocoder/");
    const v2 = {
      ...repo("v2", version("v2", ["town/b.parquet"])),
      "geocoder/fdl.json": JSON.stringify({ data_dir: "data/", note: "v2" }),
    };
    await mirror(origin(v2), env.DATA, "geocoder/");
    expect(await text("geocoder/fdl.json")).toBe(v2["geocoder/fdl.json"]);
  });

  it("Worker が読めないバージョン (削除ファイルつき) では refs/heads/main を進めない", async () => {
    await mirror(origin(repo("v1", version("v1", ["town/a.parquet"]))), env.DATA, "geocoder/");
    const v2 = {
      ...repo("v2", version("v2", [])),
      "geocoder/versions/v2/files.json": JSON.stringify({
        tables: { "town.town": { files: [{ path: "town/b.parquet", deletes: [{}] }] } },
      }),
    };
    await expect(mirror(origin(v2), env.DATA, "geocoder/")).rejects.toThrow("deletes");
    expect(await text("geocoder/refs/heads/main")).toBe("v1\n");
  });

  it("ほかの置き場のファイル (境界タイル) も、無ければ写す", async () => {
    const tiles = origin({ "boundaries/b.pmtiles": "tiles" });
    await mirror(origin(repo("v1", version("v1", []))), env.DATA, "geocoder/", [
      { origin: tiles, key: "boundaries/b.pmtiles" },
    ]);
    expect(await text("boundaries/b.pmtiles")).toBe("tiles");
    await env.DATA.delete("boundaries/b.pmtiles");
  });
});

describe("withFallback", () => {
  it("自分の R2 に無いキーは公開の URL から読む", async () => {
    await env.DATA.put("geocoder/fdl.json", "store");
    const b = withFallback(
      env.DATA,
      origin({ "geocoder/fdl.json": "origin", "geocoder/x": "origin" }),
    );
    expect(await (await b.get("geocoder/fdl.json"))?.text()).toBe("store");
    expect(await (await b.get("geocoder/x"))?.text()).toBe("origin");
    await env.DATA.delete("geocoder/fdl.json");
  });
});

describe("httpBucket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Range を付けて読み、404 は null にする", async () => {
    const seen: Request[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push(new Request(url, init));
      return url.endsWith("missing")
        ? new Response(null, { status: 404 })
        : new Response("ab", { status: 206, headers: { "Content-Range": "bytes 0-1/10" } });
    });
    const b = httpBucket("https://data.example/");
    expect((await b.head("geocoder/x"))?.size).toBe(10);
    const o = await b.get("geocoder/x", { range: { offset: 0, length: 2 } });
    expect(await o?.text()).toBe("ab");
    expect(await b.get("geocoder/missing")).toBeNull();
    expect(seen[1].url).toBe("https://data.example/geocoder/x");
    expect(seen[1].headers.get("Range")).toBe("bytes=0-1");
  });

  it("Range を付けた読みに 200 (ファイル全体) が返ったら止める", async () => {
    vi.stubGlobal("fetch", async () => new Response("abcdefghij", { status: 200 }));
    const b = httpBucket("https://data.example/");
    await expect(b.get("geocoder/x", { range: { offset: 0, length: 2 } })).rejects.toThrow(
      "without Range",
    );
    expect(await (await b.get("geocoder/x"))?.text()).toBe("abcdefghij");
  });
});
