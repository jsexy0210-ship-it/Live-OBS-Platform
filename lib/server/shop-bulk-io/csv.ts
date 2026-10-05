// CSV 읽기·쓰기(RFC 4180). 엑셀에서 열고 저장한 UTF-8 CSV(BOM 있음·없음)와 줄바꿈 CRLF·LF를 받는다. 외부 라이브러리 없이 쓴다.

export type CsvFailure = "unterminated_quote";

export function parseCsv(text: string): { ok: true; rows: string[][] } | { ok: false; reason: CsvFailure } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      wasQuoted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      wasQuoted = false;
    } else cell += c;
  }
  if (quoted) return { ok: false, reason: "unterminated_quote" };
  if (cell !== "" || row.length > 0 || wasQuoted) {
    row.push(cell);
    rows.push(row);
  }
  return { ok: true, rows };
}

// 엑셀이 수식으로 읽는 시작 글자(= + - @ 탭)는 내보낼 때 작은따옴표를 붙이고, 읽을 때 뗀다(수식 삽입 방지). 숫자 열에는 쓰지 않는다.
const FORMULA = /^[=+\-@\t\r]/;
export const guardText = (v: string) => (FORMULA.test(v) ? `'${v}` : v);
export const unguardText = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// 엑셀이 한글을 깨뜨리지 않게 BOM을 붙이고 줄바꿈은 CRLF로 쓴다.
export const formatCsv = (rows: string[][]) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
