import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  assetsBuffer,
  openSized,
  openTable,
  r2Buffer,
  readCity,
  readWhere,
  rowRangesFor,
  type Table,
} from "../src/data/parquet";
// 3 市区町村・行グループ 3 つの town (test/make-parquet-fixture.py)
import fixture from "./fixture-town.parquet";

const KEY = "test/town.parquet";
let table: Table;
let reads = 0;

beforeAll(async () => {
  await env.BUCKET.put(KEY, fixture);
  const file = r2Buffer(env.BUCKET, KEY, fixture.byteLength);
  table = await openTable(
    {
      byteLength: file.byteLength,
      slice: (start, end) => {
        reads++;
        return file.slice(start, end);
      },
    },
    { sortKey: "lg_code" },
  );
});

type Town = { lg_code: string; machiaza_id: string; oaza_cho: string };
const cols = ["machiaza_id", "oaza_cho"];

describe("rowRangesFor", () => {
  it("lg_code が入る行グループの行だけを指す", () => {
    expect(rowRangesFor(table.metadata, "131016")).toEqual([{ rowStart: 0, rowEnd: 4096 }]);
    expect(rowRangesFor(table.metadata, "131024")).toEqual([{ rowStart: 2048, rowEnd: 4096 }]);
    expect(rowRangesFor(table.metadata, "132012")).toEqual([{ rowStart: 2048, rowEnd: 6000 }]);
  });

  it("どの行グループの範囲にも入らなければ空", () => {
    expect(rowRangesFor(table.metadata, "011002")).toEqual([]);
    expect(rowRangesFor(table.metadata, "472018")).toEqual([]);
  });

  it("離れた行グループは間を読まずに別々に返す", () => {
    const [a, b, c] = table.metadata.row_groups;
    const shuffled = { ...table.metadata, row_groups: [b, a, c] };
    // 行グループの並びを入れ替え、当たる行グループの間に当たらないものを挟む
    const metadata = { ...table.metadata, row_groups: [a, c, b] };
    expect(rowRangesFor(shuffled, "132012")).toEqual([
      { rowStart: 0, rowEnd: 2048 },
      { rowStart: 4096, rowEnd: 6000 },
    ]);
    expect(rowRangesFor(metadata, "131024")).toEqual([
      { rowStart: Number(a.num_rows) + Number(c.num_rows), rowEnd: 6000 },
    ]);
  });
});

describe("readCity", () => {
  it("その市区町村の行だけを返す", async () => {
    const rows = await readCity<Town>(table, "131024", cols);
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toMatchObject({ lg_code: "131024", machiaza_id: "0000000", oaza_cho: "中0" });
  });

  it("行グループをまたぐ市区町村も全部返す", async () => {
    expect(await readCity<Town>(table, "131016", cols)).toHaveLength(3000);
    expect(await readCity<Town>(table, "132012", cols)).toHaveLength(2000);
  });

  it("範囲には入るが行の無い lg_code は空", async () => {
    expect(await readCity<Town>(table, "131032", cols)).toEqual([]);
  });

  it("範囲の外の lg_code は R2 を読まない", async () => {
    const before = reads;
    expect(await readCity<Town>(table, "472018", cols)).toEqual([]);
    expect(reads).toBe(before);
  });

  it("値をまとめて渡すと、同じ行グループは 1 回だけ読む", async () => {
    const start = reads;
    await readCity<Town>(table, "131024", cols);
    await readCity<Town>(table, "132012", cols);
    const separate = reads - start;
    const before = reads;
    const rows = await readWhere<Town>(table, "lg_code", ["131024", "132012"], cols);
    expect(rows).toHaveLength(3000);
    // 131024 は 2 つ目、132012 は 2 つ目と 3 つ目の行グループに入る。2 つ目は 1 回だけ読む
    expect(reads - before).toBe((separate * 2) / 3);
  });
});

describe("assetsBuffer", () => {
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
    const kept = new Map<string, Promise<ArrayBuffer>>();
    const file = assetsBuffer(assets, "data/town.parquet", fixture.byteLength, () => kept);
    const footer = new Uint8Array(fixture.slice(-8, -4)).reduce((n, b, i) => n + b * 256 ** i, 0);
    const t = await openSized(file, { bytes: fixture.byteLength, footer }, { sortKey: "lg_code" });
    const rows = await readCity<Town>(t, "131024", cols);
    expect(rows.length).toBeGreaterThan(0);
    expect(fetches).toEqual(["/data/town.parquet"]);
  });

  it("問い合わせが変われば取り直す", async () => {
    fetches.length = 0;
    let kept = new Map<string, Promise<ArrayBuffer>>();
    const file = assetsBuffer(assets, "data/town.parquet", fixture.byteLength, () => kept);
    await file.slice(0, 4);
    kept = new Map();
    await file.slice(0, 4);
    expect(fetches).toHaveLength(2);
  });
});
