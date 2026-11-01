// 一括変換の CSV の読み書き。ページの中だけで使う

/** CSV を行の配列に。"" で囲んだ値の中のカンマ・改行・"" を扱う。先頭の BOM は外す */
export const parseCsv = (text: string): string[][] => {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') ((cell += '"'), i++);
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      (row.push(cell), rows.push(row), (row = []), (cell = ""));
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) (row.push(cell), rows.push(row));
  return rows.filter((r) => r.some((c) => c !== ""));
};

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** 行の配列を CSV に。Excel で化けないよう BOM を付ける */
export const toCsv = (rows: unknown[][]): string =>
  "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

/** 住所の列らしい見出しを探す。無ければ 0 列目 */
export const guessAddressColumn = (header: string[]): number => {
  const i = header.findIndex((h) => /住所|所在地|address/i.test(h));
  return i === -1 ? 0 : i;
};

/** 配列を n 件ずつに分ける */
export const chunks = <T>(xs: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
