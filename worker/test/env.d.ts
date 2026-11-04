// cloudflare:test / cloudflare:workers の型に、この Worker のバインディングと export を与える
declare namespace Cloudflare {
  interface Env {
    BUCKET: R2Bucket;
    DATA: R2Bucket;
    BOUNDARY_TILES_FILE: string;
  }
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}

declare module "*.pmtiles" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.parquet" {
  const data: ArrayBuffer;
  export default data;
}
