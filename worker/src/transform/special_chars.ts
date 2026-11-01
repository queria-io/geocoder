// abrg/internal/transform/special_chars.go の写し (upstream/UPSTREAM のコミット)
// NFKC が扱わない文字と異体字をそろえる
import specialCharsData from "./special_chars.tsv";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * TSV の置き換えの組を、ファイルの順に読む。各行は "元<TAB>先" で、"<TAB># 注" を付けてよい。
 * # の行と空行は飛ばす。行の順は、同じ位置で複数が当たるときにどれが勝つかを決める
 */
export const parseSpecialCharPairs = (data: string): [string, string][] =>
  data.split("\n").flatMap((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line === "" || line.startsWith("#")) return [];
    const fields = line.split("\t");
    const ok = fields.length === 2 || (fields.length === 3 && fields[2].startsWith("#"));
    if (!ok || fields[0] === "" || fields[1] === "") {
      throw new Error(
        `special_chars.tsv line ${i + 1}: want from<TAB>to[<TAB># comment], got ${JSON.stringify(line)}`,
      );
    }
    return [[fields[0], fields[1]] as [string, string]];
  });

const pairs = parseSpecialCharPairs(specialCharsData);
const table = new Map(pairs.slice().reverse());
// Go の strings.Replacer と同じく、左から重ならずに置き換え、同じ位置では先に登録した組が勝つ。
// JS の選択 (|) も同じ位置では左の候補から試すので、ファイルの順に並べれば同じになる
const pattern = new RegExp(pairs.map(([from]) => escape(from)).join("|"), "gu");

/** 住所に使われる特殊な文字と異体字をそろえる */
export const StandardizeSpecialChars = (s: string): [string, boolean] => {
  const result = s.replace(pattern, (m) => table.get(m)!);
  return [result, result !== s];
};
