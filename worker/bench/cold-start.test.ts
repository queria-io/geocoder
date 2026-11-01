// isolate が冷たいときの固定費の内訳を手元で測る。本番と同じ Parquet を読み、Worker と同じ順に組み立てる。
// R2 から読む時間は入らない (本番のログの r2_ms を見る)。ここで測るのは CPU の分だけ
// 使い方: PARQUET_DIR=<town・city・pref の Parquet のあるフォルダ> CITY=082201 pnpm vitest run -c bench/vitest.config.ts bench/cold-start.test.ts
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { it } from "vitest";

import { compressors, readCity } from "../src/data/parquet";
import { NewMatcher } from "../src/matching/matcher";
import { lazyRepository } from "../src/repository/lazy";
import {
  TOWN_COLUMNS,
  toBasic,
  toCity,
  toPref,
  type CityTableRow,
  type PrefTableRow,
  type TownRow,
} from "../src/repository/town";

const dir = process.env.PARQUET_DIR;
const city = process.env.CITY ?? "082201";

const time = async <T>(label: string, f: () => T | Promise<T>): Promise<T> => {
  const s = performance.now();
  const r = await f();
  process.stderr.write(`${label.padEnd(28)} ${(performance.now() - s).toFixed(1)}ms\n`);
  return r;
};

const open = async (name: string) => {
  const file = await asyncBufferFromFile(`${dir}/${name}.parquet`);
  return { file, metadata: await parquetMetadataAsync(file) };
};

it.skipIf(!dir)("cold", async () => {
  const [town, cityT, pref] = await time("フッターを読む (3 表)", () =>
    Promise.all(["town", "city", "pref"].map(open)),
  );
  const cityRows = await time("市区町村の表を解凍", () =>
    parquetReadObjects({ ...cityT, compressors }),
  );
  const prefRows = await time("都道府県の表を解凍", () =>
    parquetReadObjects({ ...pref, compressors }),
  );
  const cities = await time(`市区町村名の正規化 x${cityRows.length}`, () =>
    (cityRows as CityTableRow[]).map(toCity),
  );
  const prefs = await time("都道府県名の正規化", () => (prefRows as PrefTableRow[]).map(toPref));
  const repo = await time("lazyRepository", () => lazyRepository(async () => [], cities, prefs));
  await time("NewMatcher", () => NewMatcher(repo, cities));
  const towns = await time(`町字の行を解凍 (${city})`, () =>
    readCity<TownRow>(town, city, TOWN_COLUMNS),
  );
  await time(`町字名の正規化 x${towns.length}`, () => towns.map(toBasic));
});
