// 照合の正規化。索引の名前・番号 (match_area・match_number・町字の表) と住所の両方に同じ関数を当てる。
// 表記の違い (全角・半角、漢数字、異体字、「丁目」「番地」などの区切り、「ノ」「ケ」などの省略できる字) を
// 1 つの形にそろえてから、文字列の一致で引く
const KANJI: Record<string, number> = Object.fromEntries(
  [..."〇一二三四五六七八九"].map((c, i) => [c, i]),
);
const UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

// 異体字 → 通用字 (2 文字ずつ)
const ITAI_PAIRS =
  "舘館﨑崎嵜崎嶋島澤沢邊辺邉辺齋斉齊斉槇槙冨富峯峰埜野曽曾桧檜藪薮籠篭瀧滝廣広國国條条龍竜濱浜淺浅鐵鉄櫻桜髙高德徳惠恵渕淵黑黒靜静眞真埓埒爼俎雞鶏";
const ITAI: Record<string, string> = Object.fromEntries(
  Array.from({ length: [...ITAI_PAIRS].length / 2 }, (_, i) => [
    [...ITAI_PAIRS][i * 2],
    [...ITAI_PAIRS][i * 2 + 1],
  ]),
);
const ITAI_CHARS = new RegExp(`[${Object.keys(ITAI).join("")}]`, "g");

/** 漢数字の並びを算用数字に。位取り (「二〇」) と単位 (「二十」) の両方を読む */
const kanjiNumber = (s: string): string => {
  const { total, cur } = [...s].reduce(
    (acc, ch) =>
      ch in KANJI
        ? { total: acc.total, cur: acc.cur * 10 + KANJI[ch] }
        : { total: acc.total + (acc.cur || 1) * UNIT[ch], cur: 0 },
    { total: 0, cur: 0 },
  );
  return String(total + cur);
};

const KANJI_RUN = /[〇一二三四五六七八九十百千]+/g;
const DASH = /[-‐‑–—―−ー－ｰ﹣]/g;
const SEP_AFTER_DIGIT =
  /(?<=[0-9甲乙丙丁])(丁目|丁|番地の|番地|番の|番|号|の|地割|街区|区|字|町目)/g;
const OPTIONAL = /(?<=[一-鿿々〆])[ノのケヶヵガがツッ之](?=[一-鿿々〆])/g;

export const norm = (s: string | null | undefined): string =>
  !s
    ? ""
    : s
        .normalize("NFKC")
        .replace(/\s+/g, "")
        .replace(ITAI_CHARS, (c) => ITAI[c])
        .replace(/[ヶヵ]/g, "ケ")
        // 数字の間のカタカナの長音は「-」と読む (「1ー2」)
        .replace(/(?<=[0-9〇一二三四五六七八九十])[ーｰ](?=[0-9〇一二三四五六七八九十])/g, "-")
        .replace(OPTIONAL, "")
        .replace(KANJI_RUN, kanjiNumber)
        .replace(/大字|小字/g, "")
        .replace(/(?<![0-9甲乙丙丁])字/g, "")
        .replace(/第(?=[0-9])/g, "")
        .replace(DASH, "-")
        .replace(SEP_AFTER_DIGIT, "-")
        .replace(/-+/g, "-");

/** 番号の部分 (「12」「3」「4」) を「12-3-4」の形に。空の部分は落とす */
export const numberKey = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .filter((p): p is string => p !== null && p !== undefined && p !== "")
    .map((p) => norm(p).replace(/^-+|-+$/g, ""))
    .filter((p) => p !== "")
    .join("-");
