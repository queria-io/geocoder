import { describe, expect, it } from "vitest";

import { filesFor, fromManifest, fromVersion } from "../src/data/source";

describe("fromManifest", () => {
  it("目録からの相対パスにし、無い表は空にする", () => {
    const r = fromManifest("geo/manifest.json", { version: "v1", tables: { town: ["t.parquet"] } });
    expect(r.version).toBe("v1");
    expect(r.tables.town).toEqual(["geo/t.parquet"]);
    expect(r.tables.parcel).toEqual([]);
  });
});

describe("fromVersion", () => {
  const record = { id: "01a196c3-445e-72dd-a258-2c4a98588ebd", created_at: "2026-11-01T11:04:40Z" };
  const list = {
    tables: {
      "main.parcel": { files: [{ path: "main/p1.parquet" }, { path: "main/p2.parquet" }] },
    },
  };

  it("FDL の files.json から表ごとのキーを作る", () => {
    const r = fromVersion("root/", "ducklake.duckdb.files/", record, list);
    expect(r.version).toBe("geocoder-20261101-01a196c3");
    expect(r.tables.parcel).toEqual([
      "root/ducklake.duckdb.files/main/p1.parquet",
      "root/ducklake.duckdb.files/main/p2.parquet",
    ]);
    expect(r.tables.town).toEqual([]);
  });

  it("削除ファイルや列の改名がある表は読まない", () => {
    const deletes = {
      tables: { "main.parcel": { files: [{ path: "p", deletes: { path: "d" } }] } },
    };
    expect(() => fromVersion("root/", "data/", record, deletes)).toThrow();
    const renamed = { tables: { "main.parcel": { renamed_columns: true, files: [] } } };
    expect(() => fromVersion("root/", "data/", record, renamed)).toThrow();
  });
});

describe("filesFor", () => {
  const keys = [
    "geocoder/data/main/parcel/pref_code=01/a.parquet",
    "geocoder/data/main/parcel/pref_code=13/b.parquet",
    "geocoder/data/main/parcel/pref_code=13/c.parquet",
  ];

  it("都道府県ごとに分けた表は、その都道府県のファイルだけ", () => {
    expect(filesFor(keys, "13")).toEqual(keys.slice(1));
    expect(filesFor(keys, "47")).toEqual([]);
  });

  it("分けていない表は、どの都道府県でも全部", () => {
    expect(filesFor(["town.parquet", "x/town-2.parquet"], "13")).toHaveLength(2);
  });
});
