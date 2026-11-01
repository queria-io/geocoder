import { describe, expect, it } from "vitest";

import { splitKeys } from "../src/forward";

describe("splitKeys", () => {
  it("カンマで分け、空を落とす", () => {
    expect(splitKeys("a.parquet, b.parquet,")).toEqual(["a.parquet", "b.parquet"]);
    expect(splitKeys("")).toEqual([]);
  });
});
