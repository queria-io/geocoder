// isolate が冷たいときの固定費 (市区町村の表から辞書を作るまで) を手元で測る
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { NewMatcher } from "../src/matching/matcher";
import { lazyRepository } from "../src/repository/lazy";
import { toCity, toPref } from "../src/repository/town";
import { TextForDB } from "../src/transform/text";

const t = <T>(label: string, f: () => T): T => {
  const s = performance.now();
  const r = f();
  process.stderr.write(`${label} ${(performance.now() - s).toFixed(1)}ms\n`);
  return r;
};
it("cold", () => {
  const d = "bench/abr/";
  const cities = JSON.parse(readFileSync(d + "city.json", "utf8")).map(toCity);
  const prefs = JSON.parse(readFileSync(d + "pref.json", "utf8")).map(toPref);
  const names = cities.flatMap((c) => [
    c.city,
    c.city + (c.ward ?? ""),
    (c.county ?? "") + c.city + (c.ward ?? ""),
  ]);
  t(`TextForDB x${names.length}`, () => names.map((n) => TextForDB(n)));
  const repo = t("lazyRepository", () => lazyRepository(async () => [], cities, prefs));
  t("NewMatcher", () => NewMatcher(repo, cities));
});
