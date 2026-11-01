// abrg/internal/normalize/address_hyphen.go の写し。規則の名前・順番・置き換え先は元のまま。
// Go の ${1} は JS の $1。Go の正規表現の \d と同じく、JS の \d も ASCII の数字だけ
import { ApplyFirstMatch, applyRules, type ReplaceRule } from "./pipeline";

const isASCIIDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= "0" && ch <= "9";

// 枝番に使われる文字: いろは (この段ではかなのどちらか) と十干十二支
const branchChars = "ぁ-んァ-ヶ甲乙丙丁戊己庚辛壬癸子丑寅卯夘辰巳午未申酉戌亥";
// N番 のあとに来ても建物名の始まりではない文字。番を残す
const banKeepChars = "街館先屋戸町地耕ケ川通丁内";
// 番町N のあとに来ても建物名の始まりではない文字
const banchoKeepChars = "号F街階丁";
// 丁目N番 のあとに来ても建物名の始まりではない文字
const chomeBanKeepChars = "の街先屋戸地";
// Nの/ノM に続いて同じ語になる文字。空白を入れず、の/ノ も残す
const noDigitKeepChars = "号町丁";

// 番 (街区の番号)
const banGaiWithBuilding = /(\d+番街)\s*(\d+(?:号|棟))/g;
const banGai = /(\d+)番街/g;
const banSakiNotEnd = /(\d+番先)([^\s])/g;
const banGoWithAlphanumeric = /(\d+)番(\d+)(-[A-Za-z][A-Za-z0-9]*)号/g;
const banGoShitsu = /(\d+)番(\d+)-(\d+)号室/g;
const banGoSpace = /(\d+)番(\d+(?:-\d+)*)号\s/g;
const banGoWithBuilding = /(\d+)番(\d+(?:-\d+)*)号([^\d\s])/g;
const banGoWithRoomNum = /(\d+)番(\d+(?:-\d+)*)号(\d)/g;
const banNo = /(\d+)番[のノ](\d+)/g;
const banNoGo = /(\d+)番(\d+)[のノ](\d+)号/g;
const banTou = /(\d+)番(\d+)棟/g;
const banWithHyphenNumeric = /(\d+)番(\d+)(-\d+)/g;
const banWithHyphenAlphanumeric = /(\d+)番(\d+)(-[A-Za-z][A-Za-z0-9]*)/g;
const banWithBuilding = /(\d+)番(\d+)([^\d\s-].*)/g;
const ban = /(\d+)番(\d+)/g;
const banOnly = /(\d+)番$/g;
const banBuilding = new RegExp(`(\\d+)番([^\\d${banKeepChars}])`, "g");
const banHyphenGo = /(\d+)番-(\d+)号/g;
const banHyphen = /(\d+)番-(\d+)/g;

// 番地 (地番)
const banchiGoTou = /(\d+)番地(\d+)号棟/g;
const banchiTou = /(\d+)番地(\d+)棟/g;
const banchiGo = /(\d+)番地(\d+)号/g;
const banchiNo = /(\d+)番地[のノ](\d+)/g;
const banchiNoGo = /(\d+)番地[のノ](\d+)号/g;
const banchiHyphenGo = /(\d+)番地-(\d+)号/g;
const banchiHyphen = /(\d+)番地-(\d+)/g;
const banchiWithHyphenNumeric = /(\d+)番地(\d+)(-\d+)/g;
const banchiEnd = /(\d+)番地(\d+)$/g;
const banchiBuilding = /(\d+)番地(\d+)([^\d\s-])/g;
const banchiSakiNotEnd = /(\d+番地先)([^\s])/g;
const banchiSingleEnd = /(\d+)番地$/g;
const banchiSingleNotEnd = /(\d+)番地([^\d\-先])/g;
// かなや漢字が続くと名前の始まりなので、枝番 1 文字のあとはそのどちらでもないこと
const banchiBranchWithNo = new RegExp(
  `(\\d+)番地[のノ]([${branchChars}])([^${branchChars}ー一-龯]|$)`,
  "g",
);
const banchiBranchEnd = new RegExp(`(\\d+)番地([${branchChars}])$`, "g");

// 番町 (番町で終わる町名)
const bancho = new RegExp(`(番町)(\\d+)([^\\d\\s\\-${banchoKeepChars}])`, "g");
const banchoHyphenBuilding = /(番町\d+-\d+)([^\d\s\-号])/g;
const banchoBanchi = /(\d+番町)(\d+)番地(\d+)/g;
const banchoBanGo = /(番町)(\d+)番(\d+)号/g;
const banchoBanWithNumber = /(番町)(\d+)番(\d+)/g;
const banchoBanOnly = /(番町)(\d+)番([^\d])/g;
const banchoBanEnd = /(番町)(\d+)番$/g;

// 丁目
const chome = /(丁目)(\d+)番$/g;
const chomeNotEnd = new RegExp(`(丁目)(\\d+)番([^\\d${chomeBanKeepChars}])`, "g");

// 建物・部屋・階
const gochi = /(\d+号地)(\d*)/g;
const roomNumber = /(\d+(?:-\d+)+)-(\d+室)/g;
const floorNumber = /(\d+(?:-\d+)*)-(\d+(?:F|階))/g;

// その他
const firstArabic = /([\d]+(?:-[\d]+)+)/;
const spaceBeforeNo = / [のノ](\d+)/g;
const trailingGo = /(\d+-\d+(?:-\d+)*\d+)号$/g;
const numberBeforeJapanese = /(\d)([ァ-ヶぁ-ん一-龯])/;

// の/ノ
const digitNoDigitGo = /(\d)([のノ])(\d+)号([^\d\s])/g;
const digitNoDigitGoEnd = /(\d)([のノ])(\d+)号([\s]|$)/g;
const digitNoDigit = new RegExp(`(\\d)([のノ])(\\d+)([^\\d\\s${noDigitKeepChars}])`, "g");
const digitNoDigitEnd = /(\d)([のノ])(\d+)([\s]|$)/g;

// 数字のあとに来ても空白で区切らない語
const noSpaceComponents = ["街区", "丁目", "番地", "番", "号", "線", "地割", "分区", "基線", "条"];

// addSpaceAfterNumberBeforeJapanese で、数字のあとに続いても同じ住所の語とみなす語
const addressComponents = [
  "丁目",
  "番地",
  "番丁",
  "番内",
  "番",
  "号",
  "棟",
  "階",
  "室",
  "線",
  "地割",
  "区",
  "街区",
  "条",
  "基線",
  "分区",
  "基北",
  "基南",
  "の通",
  "番通",
  "町内会",
  "林班",
  "字",
  "丁",
  "ノ町",
  "の町",
  "部",
  "本通",
  "本松",
  "本杉",
  "本柳",
  "本木",
  "の坪",
  "ノ坪",
  "ケ村",
  "ヶ村",
  "か村",
  "カ村",
];

// ハイフンにする価値がある目印。丁目はまとめて見るので、丁だけでは目印にならない
const addressMarkers = ["番", "号", "の", "ノ", "室", "階", "棟", "町", "丁目"];

const roomFloorRules: ReplaceRule[] = [
  [roomNumber, "$1 -$2"],
  [floorNumber, "$1 -$2"],
];

// 間違った 番地 の書き方。最初に当たった 1 つだけを当て、そこで終える
const illegalBanchiRules: ReplaceRule[] = [
  [banchiGoTou, "$1 $2号棟"], // N番地M号棟 → N M号棟
  [banchiTou, "$1 $2棟"], // N番地M棟 → N M棟
  [banchiGo, "$1-$2"], // N番地M号 → N-M
];

const banchiRules: ReplaceRule[] = [
  [banchiNoGo, "$1-$2"], // N番地の/ノM号 → N-M
  [banchiNo, "$1-$2"], // N番地の/ノM → N-M
  [banchiBranchWithNo, "$1-$2$3"], // N番地の/ノX (枝番 1 文字) → N-X
  [banchiBranchEnd, "$1-$2"], // N番地X (枝番 1 文字・末尾) → N-X
  [banchiHyphenGo, "$1-$2"], // N番地-M号 → N-M
  [banchiHyphen, "$1-$2"], // N番地-M → N-M
  [banchiWithHyphenNumeric, "$1-$2$3"], // N番地M-P → N-M-P
  [banchiBuilding, "$1-$2 $3"], // N番地M+建物名 → N-M 建物名
  [banchiEnd, "$1-$2"], // N番地M (末尾) → N-M
  [banchiSakiNotEnd, "$1 $2"], // N番地先+続き → N番地先 続き
  [banchiSingleEnd, "$1"], // N番地 (末尾) → N
  [banchiSingleNotEnd, "$1 $2"], // N番地 (末尾でない) → N 続き
];

const banHyphenRules: ReplaceRule[] = [
  [banHyphenGo, "$1-$2"],
  [banHyphen, "$1-$2"],
];

const banchoRules: ReplaceRule[] = [
  [banchoBanchi, "$1$2-$3"], // N番町M番地O → N番町M-O
  [banchoBanGo, "$1$2-$3"], // 番町N番M号 → 番町N-M
  [banchoBanWithNumber, "$1$2-$3"], // 番町N番M → 番町N-M
  [banchoBanOnly, "$1$2$3"], // 番町N番[数字以外] → 番町N[数字以外]
  [banchoBanEnd, "$1$2"], // 番町N番 (末尾) → 番町N
  [banchoHyphenBuilding, "$1 $2"], // 番町N-M[建物] → 番町N-M [建物]
];

// banNoGo を先に当てて、N番MのO号 を普通の 番/号 の規則より先に片付ける
const banGoRules: ReplaceRule[] = [
  [banNoGo, "$1-$2-$3"], // N番MのO号 → N-M-O
  [banGoWithAlphanumeric, "$1-$2 $3"],
  [banGoShitsu, "$1-$2 -$3号室"],
  [banGoWithBuilding, "$1-$2 $3"], // N番M号+建物名 → N-M 建物名
  [banGoWithRoomNum, "$1-$2 $3"], // N番M号+部屋番号 → N-M 部屋番号
  [banGoSpace, "$1-$2 "], // N番M号+空白 → N-M (空白は残す)
];

const noAfterDigitRules: ReplaceRule[] = [
  [digitNoDigitGo, "$1-$3 $4"], // Nの/ノM号X → N-M X
  [digitNoDigitGoEnd, "$1-$3$4"], // Nの/ノM号 (末尾・空白の前) → N-M
  [digitNoDigit, "$1-$3 $4"], // Nの/ノMX → N-M X
  [digitNoDigitEnd, "$1-$3$4"], // Nの/ノM (末尾) → N-M
];

const goAndPostfixRules: ReplaceRule[] = [
  [trailingGo, "$1"], // ハイフンにした住所の末尾の 号 を落とす
  [gochi, "$1$2"], // 号地
  [bancho, "$1$2 $3"], // ○番町 + 建物名
];

const scanAddressMarkers = (s: string) => ({
  hasMarker: addressMarkers.some((m) => s.includes(m)),
  hasFloor: /\dF/.test(s),
});

const processBanchi = (s: string): string => {
  const a = s.includes("番地") ? applyRules(s, banchiRules) : s;
  return a.includes("番-") ? applyRules(a, banHyphenRules) : a;
};

/** 末尾の N番M号 を N-M にする。元は正規表現より速いので手で走査している */
const replaceBanGoEnd = (s: string): string => {
  if (!s.endsWith("号")) return s;
  const banIdx = s.lastIndexOf("番");
  if (banIdx < 1 || !isASCIIDigit(s[banIdx - 1])) return s;
  let numStart = banIdx - 1;
  while (numStart > 0 && isASCIIDigit(s[numStart - 1])) numStart--;
  const between = s.slice(banIdx + 1, -1);
  if (between === "" || !isASCIIDigit(between[0])) return s;
  if (!Array.from(between.slice(1)).every((ch) => isASCIIDigit(ch) || ch === "-")) return s;
  return s.slice(0, banIdx) + "-" + between;
};

/** N番街 を続く建物名から切り離す。数字のあとの N番街 は境目に空白を入れる */
const processBanGai = (s: string): string => {
  const next = s.replace(banGaiWithBuilding, "$1 $2");
  if (next !== s) return next;
  banGai.lastIndex = 0;
  const loc = banGai.exec(s);
  banGai.lastIndex = 0;
  if (loc && loc.index > 0 && isASCIIDigit(s[loc.index - 1])) {
    return s.replace(banGai, "$1番街 ");
  }
  return s;
};

/** 番 の書き方をハイフンにする。plainBan は 号・棟 の付かない N番M の規則を使うか */
const processBan = (input: string, plainBan: boolean): string => {
  let s = input;
  // N番街, N番先 を先に (番屋敷・番戸・番館 は banBuilding の除外で残る)
  if (s.includes("番街")) s = processBanGai(s);
  if (s.includes("番先")) s = s.replace(banSakiNotEnd, "$1 $2");
  if (s.includes("棟")) s = s.replace(banTou, "$1 $2棟");
  if (s.includes("号")) s = replaceBanGoEnd(applyRules(s, banGoRules));
  if (s.includes("番の") || s.includes("番ノ")) s = s.replace(banNo, "$1-$2");
  if (s.includes("丁目")) s = s.replace(chome, "$1$2").replace(chomeNotEnd, "$1$2 $3");
  if (plainBan) {
    if (s.includes("-")) {
      s = s.replace(banWithHyphenNumeric, "$1-$2$3").replace(banWithHyphenAlphanumeric, "$1-$2 $3");
    }
    s = s.replace(banWithBuilding, "$1-$2 $3").replace(ban, "$1-$2");
  }
  if (s.endsWith("番")) s = s.replace(banOnly, "$1");
  return s.replace(banBuilding, "$1 $2");
};

// の/ノ をハイフンにするのは、前が数字のときだけ。「アケボノ1丁目」や北海道の小字「南大沼ノ1」を壊さない
const processNoPatterns = (s: string): string => {
  if (!/[のノ]\d/.test(s)) return s;
  return applyRules(
    s.replace(spaceBeforeNo, (m) => m.slice(1)),
    noAfterDigitRules,
  );
};

/** 数字+番+数字(-数字)*+号 があるか */
const hasBanGoPattern = (s: string): boolean => {
  const idx = s.indexOf("号");
  if (idx < 1) return false;
  const banIdx = s.lastIndexOf("番", idx - 1);
  if (banIdx < 1 || !isASCIIDigit(s[banIdx - 1])) return false;
  const between = s.slice(banIdx + 1, idx);
  return between !== "" && isASCIIDigit(between[0]);
};

/** 数字+番+数字+棟 があるか */
const hasBanTouPattern = (s: string): boolean => {
  const idx = s.indexOf("棟");
  if (idx < 1 || !isASCIIDigit(s[idx - 1])) return false;
  const banIdx = s.lastIndexOf("番", idx - 1);
  return banIdx >= 1 && isASCIIDigit(s[banIdx - 1]);
};

/** 住所の番号の書き方 (番地・番・号) をハイフンにする */
export const AddressNumbersToHyphen = (original: string): [string, boolean] => {
  if (!/\d/.test(original)) return [original, false];
  const { hasMarker, hasFloor } = scanAddressMarkers(original);
  if (!hasMarker && !hasFloor) return [original, false];

  // 号・棟 の付く N番M は専用の規則で扱うので、素の N番M の規則は使わない。
  // どの段も後ろを書き換えないうちに、元の入力で決める
  const plainBan = !hasBanGoPattern(original) && !hasBanTouPattern(original);

  let s = original;
  // 1: 部屋・階
  if (s.includes("室") || s.includes("F") || s.includes("階")) s = applyRules(s, roomFloorRules);
  // 2: 間違った 番地 の書き方 (当たればここで終える)
  if (s.includes("番地")) {
    const [result, done] = ApplyFirstMatch(s, illegalBanchiRules);
    if (done) return [result, result !== original];
  }
  // 3-5: 番地・番町・番
  if (s.includes("番")) {
    s = processBanchi(s);
    if (s.includes("番町")) s = applyRules(s, banchoRules);
    s = processBan(s, plainBan);
  }
  // 6: の/ノ (番が無くても当てる)
  s = processNoPatterns(s);
  // 7: 号と後処理
  if (s.includes("号") || s.includes("番町")) s = applyRules(s, goAndPostfixRules);
  return [s, s !== original];
};

/** 最初の N-N(-N)* のあとに空白を入れ、住所と建物名・部屋番号を分ける */
export const addSpaceAfterFirstArabicNumber = (s: string): [string, boolean] => {
  const m = firstArabic.exec(s);
  if (!m) return [s, false];
  const end = m.index + m[0].length;
  const after = s.slice(end);
  // 「11-2街区」のように続く語は分けない
  if (noSpaceComponents.some((comp) => after.startsWith(comp))) return [s, false];
  if (end < s.length && s[end] !== " ") {
    const result = s.slice(0, end) + " " + after;
    return [result, true];
  }
  return [s, false];
};

// の/ノ が街区の区切り (本町6の1丁目) か、石川の末尾の Nの/Nノ (金沢市天池町1ノ)
const isNoParticleBlock = (after: string): boolean => {
  const [first, second] = Array.from(after);
  if (first !== "の" && first !== "ノ") return false;
  return second === undefined || isASCIIDigit(second);
};

// 北海道 中標津の「東1北2丁目」のように、漢字+数字が 丁目 に続く
const isKanjiDigitChome = (after: string): boolean => {
  const [first, second] = Array.from(after);
  const cp = first?.codePointAt(0) ?? 0;
  if (cp < 0x4e00 || cp > 0x9fff) return false;
  return isASCIIDigit(second) && after.includes("丁目");
};

const sameAddressToken = (after: string): boolean =>
  addressComponents.some((comp) => after.startsWith(comp)) ||
  isNoParticleBlock(after) ||
  isKanjiDigitChome(after);

/** 数字のあとに日本語が続くとき、同じ住所の語でなければ空白を入れる。残す語に当たったら止める */
export const addSpaceAfterNumberBeforeJapanese = (original: string): [string, boolean] => {
  let s = original;
  for (;;) {
    const m = numberBeforeJapanese.exec(s);
    if (!m) break;
    const pos = m.index + 1;
    if (sameAddressToken(s.slice(pos))) break;
    s = s.slice(0, pos) + " " + s.slice(pos);
  }
  return [s, s !== original];
};
