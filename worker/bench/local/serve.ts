// 手元のフォルダを Range つきで返すサーバー (精度チェック用)。
// 使い方: tsx bench/local/serve.ts <フォルダ> [ポート]
import { createServer } from "node:http";
import { open, stat } from "node:fs/promises";
import { join, normalize } from "node:path";

const [root, port = "8788"] = process.argv.slice(2);

const bytes = async (path: string, start: number, length: number) => {
  const file = await open(path);
  const body = Buffer.alloc(length);
  await file.read(body, 0, length, start).finally(() => file.close());
  return body;
};

createServer(async (req, res) => {
  const path = join(
    root,
    normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)),
  );
  const size = await stat(path).then(
    (s) => (s.isFile() ? s.size : -1),
    () => -1,
  );
  if (size < 0) return res.writeHead(404).end();
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  const start = range ? Number(range[1]) : 0;
  const end = range ? Math.min(Number(range[2]), size - 1) : size - 1;
  const body = await bytes(path, start, end - start + 1);
  res
    .writeHead(range ? 206 : 200, {
      "Content-Length": body.length,
      ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
    })
    .end(body);
}).listen(Number(port), "127.0.0.1");
