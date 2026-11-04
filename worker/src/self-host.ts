// セルフホスト用の入口 (wrangler.self-host.jsonc)。本体の Worker をそのまま使い、読む先だけを差し替える。
//   - 既定: 公開のデータ (DATA_URL の geocoder、ASSETS_URL の境界タイル) を HTTP の Range で直接読む。
//     データは Queria の更新にそのまま追従する
//   - STORE (自分の R2) を付けたとき: Cron Trigger で公開のデータを STORE に取り込み、STORE から読む。
//     取り込みが終わるまでは、STORE に無いファイルを公開の URL から読む
import app, { type Env } from "./index";
import { httpBucket, withFallback } from "./self_host/http";
import { mirror } from "./self_host/mirror";

type SelfHostEnv = Omit<Env, "DATA" | "BUCKET"> & {
  /** geocoder のデータの置き場の URL。DATA_SOURCE はこの下のパス */
  DATA_URL: string;
  /** 境界タイル (boundaries/BOUNDARY_TILES_FILE) の置き場の URL */
  ASSETS_URL: string;
  STORE?: R2Bucket;
  /** Queria の API キー (任意、wrangler secret put QUERIA_TOKEN)。data.queria.io の回数の上限がキーごとになる */
  QUERIA_TOKEN?: string;
};

const buckets = (env: SelfHostEnv) => {
  const data = httpBucket(env.DATA_URL, env.QUERIA_TOKEN);
  const assets = httpBucket(env.ASSETS_URL);
  return env.STORE
    ? { data, assets, DATA: withFallback(env.STORE, data), BUCKET: withFallback(env.STORE, assets) }
    : { data, assets, DATA: data, BUCKET: assets };
};

export default {
  fetch: (request, env, ctx) => {
    const { DATA, BUCKET } = buckets(env);
    return app.fetch(request, { ...env, DATA, BUCKET }, ctx);
  },
  scheduled: async (_controller, env) => {
    if (!env.STORE) return;
    const { data, assets } = buckets(env);
    const result = await mirror(data, env.STORE, env.DATA_SOURCE, [
      { origin: assets, key: `boundaries/${env.BOUNDARY_TILES_FILE}` },
    ]);
    console.log("geocoder: mirror", JSON.stringify(result));
  },
} satisfies ExportedHandler<SelfHostEnv>;
