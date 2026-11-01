// abrg/internal/matching/detect_prefecture.go の写し (upstream/UPSTREAM のコミット)

const prefectureNames = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
];

const prefecturePrefixes = new Map(
  prefectureNames.map((name, i) => [name, String(i + 1).padStart(2, "0")]),
);
const prefectureByCode = new Map([...prefecturePrefixes].map(([name, code]) => [code, name]));

/** 頭の都道府県名からコードを引く。名前は 3 文字か 4 文字で、短い名前が長い名前の頭になることは無い */
export const detectPrefectureCode = (address: string): string =>
  prefecturePrefixes.get(address.slice(0, 4)) ?? prefecturePrefixes.get(address.slice(0, 3)) ?? "";

/** 頭の都道府県名を外す。外すと何も残らないときはそのまま */
export const removePrefectureFromAddress = (address: string, prefCode: string): string => {
  const name = prefectureByCode.get(prefCode);
  if (name === undefined || !address.startsWith(name)) return address;
  const rest = address.slice(name.length).replace(/^ +/, "");
  return rest === "" ? address : rest;
};
