import { env } from "cloudflare:workers";
import { type ParquetFile, r2Store, type Store } from "@queria-io/fdl-js";
import { beforeAll, describe, expect, it } from "vitest";

import { assetsStore, openFile, readWhere } from "../src/data/parquet";
// 3 市区町村・行グループ 3 つの town (test/make-parquet-fixture.py)
import fixture from "./fixture-town.parquet";

const KEY = "test/town.parquet";
let table: ParquetFile;
let reads = 0;

/** 読んだ回数を数える store */
const counted = (store: Store): Store => ({
  ...store,
  range: (key, offset, length) => {
    reads++;
    return store.range(key, offset, length);
  },
});

beforeAll(async () => {
  await env.BUCKET.put(KEY, fixture);
  table = await openFile(counted(r2Store(env.BUCKET)), KEY);
});

type Town = { lg_code: string; machiaza_id: string; oaza_cho: string };
const cols = ["machiaza_id", "oaza_cho"];
const readCity = (lgCode: string) => readWhere<Town>(table, "lg_code", [lgCode], cols);

describe("readWhere", () => {
  it("その市区町村の行だけを返す", async () => {
    const rows = await readCity("131024");
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toMatchObject({ lg_code: "131024", machiaza_id: "0000000", oaza_cho: "中0" });
  });

  it("行グループをまたぐ市区町村も全部返す", async () => {
    expect(await readCity("131016")).toHaveLength(3000);
    expect(await readCity("132012")).toHaveLength(2000);
  });

  it("範囲には入るが行の無い lg_code は空", async () => {
    expect(await readCity("131032")).toEqual([]);
  });

  it("範囲の外の lg_code は R2 を読まない", async () => {
    const before = reads;
    expect(await readCity("472018")).toEqual([]);
    expect(reads).toBe(before);
  });

  it("最小・最大で選んだ行グループの行数を数える", async () => {
    const counts: number[] = [];
    await readWhere<Town>(table, "lg_code", ["131024", "132012"], cols, (n) => counts.push(n));
    // 131024 は 2 つ目、132012 は 2 つ目と 3 つ目の行グループに入る
    expect(counts).toEqual([6000 - 2048]);
  });

  it("値をまとめて渡すと、同じ行グループは 1 回だけ読む", async () => {
    const start = reads;
    await readCity("131024");
    await readCity("132012");
    const separate = reads - start;
    const before = reads;
    const rows = await readWhere<Town>(table, "lg_code", ["131024", "132012"], cols);
    expect(rows).toHaveLength(3000);
    expect(reads - before).toBeLessThan(separate);
  });
});

describe("assetsStore", () => {
  // 静的アセットは Range を受けず、いつもファイル全体を返す
  const fetches: string[] = [];
  const assets = {
    fetch: async (req: Request) => {
      fetches.push(new URL(req.url).pathname);
      return new Response(fixture);
    },
  } as unknown as Fetcher;

  it("ファイルを 1 回だけ丸ごと取り、問い合わせの中ではそこから切り出す", async () => {
    fetches.length = 0;
    const store = assetsStore(assets, new Map());
    const footer = new Uint8Array(fixture.slice(-8, -4)).reduce((n, b, i) => n + b * 256 ** i, 0);
    const t = await openFile(store, "data/town.parquet", { bytes: fixture.byteLength, footer });
    const rows = await readWhere<Town>(t, "lg_code", ["131024"], cols);
    expect(rows.length).toBeGreaterThan(0);
    expect(fetches).toEqual(["/data/town.parquet"]);
  });

  it("問い合わせが変われば取り直す", async () => {
    fetches.length = 0;
    await assetsStore(assets, new Map()).range("data/town.parquet", 0, 4);
    await assetsStore(assets, new Map()).range("data/town.parquet", 0, 4);
    expect(fetches).toHaveLength(2);
  });
});
