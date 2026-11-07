import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import {
  endRequest,
  groupsFor,
  openTable,
  r2Buffer,
  readCity,
  type Table,
} from "../src/data/parquet";
// 3 市区町村・行グループ 3 つの town (test/make-parquet-fixture.py)
import fixture from "./fixture-town.parquet";

type Town = { lg_code: string; machiaza_id: string; oaza_cho: string };
const cols = ["machiaza_id", "oaza_cho"];

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
    { sortKey: "lg_code", columns: cols },
  );
});

describe("groupsFor", () => {
  it("lg_code が入る行グループの番号を返す", () => {
    expect(groupsFor(table.index, "131016")).toEqual([0, 1]);
    expect(groupsFor(table.index, "131024")).toEqual([1]);
    expect(groupsFor(table.index, "132012")).toEqual([1, 2]);
  });

  it("どの行グループの範囲にも入らなければ空", () => {
    expect(groupsFor(table.index, "011002")).toEqual([]);
    expect(groupsFor(table.index, "472018")).toEqual([]);
  });

  it("行グループがファイルの中で並んでいなくても、当たるものを全部返す", () => {
    const [a, b, c] = table.index.groups;
    expect(groupsFor({ ...table.index, groups: [c, a, b] }, "131016")).toEqual([1, 2]);
  });

  it("読む列と並べた列だけを持つ", () => {
    expect(table.index.columns.map((c) => c.path[0]).toSorted()).toEqual(
      ["lg_code", ...cols].toSorted(),
    );
  });
});

describe("readCity", () => {
  it("その市区町村の行だけを返す", async () => {
    const rows = await readCity<Town>(table, "131024");
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toMatchObject({ lg_code: "131024", machiaza_id: "0000000", oaza_cho: "中0" });
  });

  it("行グループをまたぐ市区町村も全部返す", async () => {
    expect(await readCity<Town>(table, "131016")).toHaveLength(3000);
    expect(await readCity<Town>(table, "132012")).toHaveLength(2000);
  });

  it("範囲には入るが行の無い lg_code は空", async () => {
    expect(await readCity<Town>(table, "131032")).toEqual([]);
  });

  it("範囲の外の lg_code は R2 を読まない", async () => {
    const before = reads;
    expect(await readCity<Town>(table, "472018")).toEqual([]);
    expect(reads).toBe(before);
  });

  it("同じ行グループを続けて引くときは読み直さない", async () => {
    await readCity<Town>(table, "131016");
    const before = reads;
    expect(await readCity<Town>(table, "131016")).toHaveLength(3000);
    expect(await readCity<Town>(table, "131032")).toEqual([]);
    expect(reads).toBe(before);
  });
});

describe("TableIndex", () => {
  it("JSON にしてから戻しても同じ行を読める (データセンターのキャッシュに置く形)", async () => {
    const copy: Table = { file: table.file, index: JSON.parse(JSON.stringify(table.index)) };
    endRequest();
    expect(await readCity<Town>(copy, "132012")).toEqual(await readCity<Town>(table, "132012"));
  });
});
