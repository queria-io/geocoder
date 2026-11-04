// R2 のバインディングの代わりに、公開の URL を HTTP の Range で読むバケット。セルフホスト用。
// Worker が使う get (Range つき) と head だけを持つ
type Range = { offset: number; length: number };

const read = async (base: string, key: string, range?: Range): Promise<Response | null> => {
  const headers = new Headers({ "Accept-Encoding": "identity" });
  if (range) headers.set("Range", `bytes=${range.offset}-${range.offset + range.length - 1}`);
  const res = await fetch(base + key, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${base}${key}`);
  return res;
};

const sizeOf = (res: Response): number =>
  Number(res.headers.get("Content-Range")?.split("/")[1] ?? res.headers.get("Content-Length"));

// R2 の get が返すものと同じく、本文 (body・text・arrayBuffer) と etag を持つ
const asObject = (res: Response) =>
  Object.assign(res, { etag: res.headers.get("ETag") ?? undefined, size: sizeOf(res) });

export const httpBucket = (base: string): R2Bucket =>
  ({
    get: async (key: string, options?: { range?: Range }) => {
      const res = await read(base, key, options?.range);
      // Range を無視した 200 はファイル全体なので、頼んだ範囲として返さない (Parquet の読み違いになる)
      if (res && options?.range && res.status !== 206) {
        await res.body?.cancel();
        throw new Error(`${res.status} without Range: ${base}${key}`);
      }
      return res && asObject(res);
    },
    head: async (key: string) => {
      const res = await read(base, key, { offset: 0, length: 1 });
      if (!res) return null;
      await res.body?.cancel();
      return { size: sizeOf(res) };
    },
  }) as unknown as R2Bucket;

/** 自分の R2 にあればそれを、無ければ公開の URL を読む (取り込みが終わるまでの間も答えられるように) */
export const withFallback = (store: R2Bucket, origin: R2Bucket): R2Bucket =>
  ({
    get: async (key: string, options?: R2GetOptions) =>
      (await store.get(key, options)) ?? origin.get(key, options),
    head: async (key: string) => (await store.head(key)) ?? origin.head(key),
  }) as unknown as R2Bucket;
