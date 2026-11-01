// 手元で流す重い試験 (bench/*.test.ts) の設定。Workers ではなく Node で流す
import { readFileSync } from "node:fs";

import { defineConfig, type Plugin } from "vitest/config";

const tsvText: Plugin = {
  name: "tsv-text",
  load(id) {
    return id.endsWith(".tsv")
      ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};`
      : null;
  },
};

export default defineConfig({
  plugins: [tsvText],
  test: { include: ["bench/**/*.test.ts"], testTimeout: 600_000, hookTimeout: 600_000 },
});
