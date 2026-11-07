import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { openTable, r2Buffer, readCity, rowRangesFor, type Table } from "../src/data/parquet";
// 3 市区町村・行グループ 3 つの town (test/make-parquet-fixture.py)
import fixture from "./fixture-town.parquet";

const KEY = "test/town.parquet";
let table: Table;
let reads = 0;

beforeAll(async () => {
  await env.BUCKET.put(KEY, fixture);
  const file = r2Buffer(env.BUCKET, KEY, fixture.byteLength);
  table = await openTable({
    byteLength: file.byteLength,
    slice: (start, end) => {
      reads++;
      return file.slice(start, end);
    },
  });
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

  it("同じ行グループを続けて引くときは読み直さない", async () => {
    await readCity<Town>(table, "131016", cols);
    const before = reads;
    expect(await readCity<Town>(table, "131016", cols)).toHaveLength(3000);
    expect(await readCity<Town>(table, "131032", cols)).toEqual([]);
    expect(reads).toBe(before);
  });
});
