// 直下のデータセットの Parquet を、Worker の静的アセット (丸ごと) か R2 (Range) から fdl-js で読む。表は都道府県・
// 市区町村ごとのファイルに分かれ、ファイルの中は lg_code などの列の順に並べてある。フッターの行グループごとの
// その列の最小・最大で、値が入る行グループだけを読む。DuckDB もカタログも使わない
import {
  type FooterCache,
  NotFoundError,
  type OnRead,
  openParquet,
  type ParquetFile,
  readWhere as readWhereFdl,
  rowRangesFor,
  type Store,
} from "@queria-io/fdl-js";

/**
 * 静的アセットを fdl-js の store にする。静的アセットは Range を受けないので、最初の読みでファイルを丸ごと取り、
 * あとはその中から切り出す。取ったファイルは kept に置き、問い合わせが終われば手放す (isolate には残さない)
 */
export const assetsStore = (
  assets: Fetcher,
  kept: Map<string, Promise<ArrayBuffer>>,
  onRead?: OnRead,
): Store => {
  const whole = (key: string) => {
    const hit = kept.get(key);
    if (hit) return hit;
    const t0 = Date.now();
    const p = assets.fetch(new Request(`https://assets.local/${key}`)).then(async (r) => {
      if (r.status === 404) throw new NotFoundError(key);
      if (!r.ok) throw new Error(`${r.status}: ${key}`);
      const body = await r.arrayBuffer();
      onRead?.(body.byteLength, Date.now() - t0);
      return body;
    });
    kept.set(key, p);
    p.catch(() => kept.delete(key));
    return p;
  };
  // Store の約束どおり、無いファイルは text と size では null にする
  const orNull = <T>(p: Promise<T>): Promise<T | null> =>
    p.catch((e: unknown) => (e instanceof NotFoundError ? null : Promise.reject(e)));
  return {
    text: (key) => orNull(whole(key).then((b) => new TextDecoder().decode(b))),
    size: (key) => orNull(whole(key).then((b) => b.byteLength)),
    range: async (key, offset, length) => (await whole(key)).slice(offset, offset + length),
  };
};

/**
 * ファイルを開く (フッターを読む)。大きさが分からなければ store に問い合わせる。フッターの長さ (footer) も
 * 分かれば、フッターを 1 回の読みで取れる
 */
export const openFile = async (
  store: Store,
  key: string,
  size?: { bytes: number; footer?: number },
  options: { onRead?: OnRead; cache?: FooterCache } = {},
): Promise<ParquetFile> => {
  const bytes = size?.bytes ?? (await store.size(key));
  if (bytes === null) throw new Error(`not found: ${key}`);
  // openParquet は行数を使わない (目録のファイルは行数が分からない)
  const file = {
    key,
    rows: 0,
    bytes,
    ...(size?.footer !== undefined ? { footerBytes: size.footer } : {}),
  };
  return openParquet(store, file, options);
};

type Value = string | number;

/** 列の値を比較できる形にする。BIGINT の列 (area_id) は hyparquet が bigint で返すので数にする */
export const valueOf = (v: unknown): Value | null =>
  typeof v === "string" || typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null;

/**
 * 並べた列 key が values のどれかである行を読む。値が同じ行グループに入っていても、その行グループは 1 回だけ読む。
 * onRows には、最小・最大で選んだ行グループの行数を渡す
 */
export const readWhere = async <T>(
  file: ParquetFile,
  key: string,
  values: readonly Value[],
  columns: string[],
  onRows?: (rows: number) => void,
): Promise<T[]> => {
  if (values.length === 0) return [];
  const condition = { in: values };
  onRows?.(
    rowRangesFor(file.metadata, key, condition).reduce((n, r) => n + r.rowEnd - r.rowStart, 0),
  );
  return readWhereFdl<T>(file, key, condition, columns);
};
