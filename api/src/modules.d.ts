// 上流の表 (special_chars.tsv) を文字列として import する。wrangler は rules の Text、テストは vitest.config.ts
declare module "*.tsv" {
  const text: string;
  export default text;
}
