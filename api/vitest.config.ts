import { readFileSync } from "node:fs";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, type Plugin } from "vitest/config";

/** テストの PMTiles (test/fixture.pmtiles) を ArrayBuffer として import できるようにする */
const pmtilesFixture: Plugin = {
  name: "pmtiles-fixture",
  load(id) {
    if (!id.endsWith(".pmtiles")) return null;
    const base64 = readFileSync(id).toString("base64");
    return `export default Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0)).buffer;`;
  },
};

export default defineConfig({
  plugins: [
    pmtilesFixture,
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
