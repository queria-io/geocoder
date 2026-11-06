// 精度チェック用の入口 (wrangler dev -c bench/local/wrangler.jsonc)。本体の Worker をそのまま使い、
// DATA だけを差し替える。URL のキー (本番のファイル) はその URL から、ほかのキー (PR で作り直した表と
// FDL のメタデータ) は手元のサーバー (serve.ts) から、Range で読む
import app, { type Env } from "../../src/index";

type LocalEnv = Env & { LOCAL_DATA: string; QUERIA_TOKEN?: string };
type Range = { offset: number; length: number };

const read = async (env: LocalEnv, key: string, range?: Range): Promise<Response | null> => {
  const remote = /^https?:\/\//.test(key);
  const headers = new Headers();
  if (range) headers.set("Range", `bytes=${range.offset}-${range.offset + range.length - 1}`);
  // data.queria.io の回数の上限は、トークンを付けるとキーごとに数える
  if (remote && env.QUERIA_TOKEN) headers.set("Authorization", `Bearer ${env.QUERIA_TOKEN}`);
  const res = await fetch(remote ? key : env.LOCAL_DATA + key, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${key}`);
  return res;
};

const sizeOf = (res: Response) =>
  Number(res.headers.get("Content-Range")?.split("/")[1] ?? res.headers.get("Content-Length"));

// Worker が使う get (Range つき) と head だけを持つ
const bucket = (env: LocalEnv) =>
  ({
    get: async (key: string, options?: { range?: Range }) => read(env, key, options?.range),
    head: async (key: string) => {
      const res = await read(env, key, { offset: 0, length: 1 });
      return res && { size: sizeOf(res) };
    },
  }) as unknown as R2Bucket;

export default {
  fetch: (request, env, ctx) => app.fetch(request, { ...env, DATA: bucket(env) }, ctx),
} satisfies ExportedHandler<LocalEnv>;
