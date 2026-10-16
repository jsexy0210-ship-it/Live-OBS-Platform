import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// 엑셀(.xlsx) 최소 읽기·쓰기(SA-018). 외부 라이브러리 없이 zip(저장·deflate)과 시트 XML만 다룬다.
// - 읽기: 첫 번째 시트의 셀 값을 문자열 행렬로 읽는다(공유 문자열·인라인 문자열·수식 결과 값·숫자·참/거짓). 서식·그림·매크로는 읽지 않는다.
// - 보안(업로드 파일은 믿지 않는다): 파일 5MB 이하, zip64·암호화·같은 이름 두 번·경로를 벗어나는 이름 거부, 항목 수·선언한 압축 해제 크기 합계 한도,
//   압축을 풀 때 선언 크기를 넘으면 중단(압축 폭탄)하고 크기·CRC가 선언과 다르면 거부, DOCTYPE·ENTITY가 든 XML 거부(엔티티 폭발 방지),
//   디스크에 쓰지 않고(경로 순회 불가) 필요한 항목(workbook·rels·sharedStrings·첫 시트)만 이름으로 찾아 푼다.
export const XLSX_MAX_BYTES = 5 * 1024 * 1024;
export const XLSX_MAX_ROW_NUMBER = 20_000;
const MAX_ENTRIES = 256;
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_SHEET_BYTES = 32 * 1024 * 1024;
const MAX_SHARED_BYTES = 16 * 1024 * 1024;
const MAX_SMALL_BYTES = 1024 * 1024;
const MAX_SHARED_STRINGS = 200_000;
const MAX_COLS = 64;
const MAX_CELL_CHARS = 32_767;

export type XlsxFailure = "invalid_xlsx" | "xlsx_too_large" | "too_many_rows";
export type XlsxRead = { ok: true; rows: string[][] } | { ok: false; reason: XlsxFailure };

const fail = (reason: XlsxFailure): XlsxRead => ({ ok: false, reason });
class Bad extends Error {
  constructor(readonly reason: XlsxFailure) {
    super(reason);
  }
}
const bad = (reason: XlsxFailure = "invalid_xlsx"): never => {
  throw new Bad(reason);
};

// ───────────── zip 읽기 ─────────────

type Entry = { name: string; method: number; crc: number; compSize: number; size: number; offset: number };

function readEntries(buf: Buffer): Map<string, Entry> {
  // 끝 기록(EOCD): 파일 끝에서 거꾸로 찾는다(주석이 붙을 수 있어 최대 65,557바이트)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) bad();
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) bad(); // zip64
  if (total === 0 || total > MAX_ENTRIES || cdOffset + cdSize > eocd) bad();
  const entries = new Map<string, Entry>();
  let p = cdOffset;
  let declared = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) bad();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) bad();
    if (flags & 1) bad(); // 암호화
    if (compSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) bad();
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // 경로를 벗어나거나 이상한 이름은 파일 전체를 거부한다(디스크에 쓰지는 않지만 방어를 겹친다)
    if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..")) bad();
    if (entries.has(name)) bad(); // 같은 이름 두 번
    declared += size;
    if (declared > MAX_TOTAL_UNCOMPRESSED) bad("xlsx_too_large");
    entries.set(name, { name, method, crc, compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readData(buf: Buffer, e: Entry, maxBytes: number): Buffer {
  if (e.size > maxBytes) bad("xlsx_too_large");
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) bad();
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const end = start + e.compSize;
  if (end > buf.length) bad();
  const raw = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) {
    if (e.compSize !== e.size) bad();
    out = raw;
  } else if (e.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: e.size });
    } catch {
      return bad(); // 선언 크기를 넘거나 깨진 압축
    }
  } else return bad();
  if (out.length !== e.size || crc32(out) !== e.crc) bad();
  return out;
}

// ───────────── XML 읽기 ─────────────

const ENTITY = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g;
function decode(s: string): string {
  return s.replace(ENTITY, (_m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
function xmlText(buf: Buffer): string {
  const s = buf.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) bad();
  return s;
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[2] ?? m[3] ?? "");
  return out;
}
// <t> 글자 모으기(루비 읽기 <rPh>는 뺀다)
function textRuns(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of clean.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += decode(m[1] ?? "");
  return out;
}

function sharedStrings(buf: Buffer, entries: Map<string, Entry>): string[] {
  const e = entries.get("xl/sharedStrings.xml");
  if (!e) return [];
  const xml = xmlText(readData(buf, e, MAX_SHARED_BYTES));
  const list: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    if (list.length >= MAX_SHARED_STRINGS) bad("xlsx_too_large");
    list.push(textRuns(m[1] ?? ""));
  }
  return list;
}

// 첫 번째 시트 파일 이름(workbook.xml의 첫 sheet → rels의 Target). 없으면 xl/worksheets/sheet1.xml.
function firstSheetPath(buf: Buffer, entries: Map<string, Entry>): string {
  const wb = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");
  if (wb && rels) {
    const wbXml = xmlText(readData(buf, wb, MAX_SMALL_BYTES));
    const sheetTag = /<sheet\b[^>]*>/.exec(wbXml)?.[0];
    const rid = sheetTag ? (attrs(sheetTag)["r:id"] ?? attrs(sheetTag).id) : undefined;
    if (rid) {
      for (const m of xmlText(readData(buf, rels, MAX_SMALL_BYTES)).matchAll(/<Relationship\b[^>]*>/g)) {
        const a = attrs(m[0]);
        if (a.Id === rid && a.Target) {
          const t = a.Target.startsWith("/") ? a.Target.slice(1) : `xl/${a.Target}`;
          if (t.split("/").includes("..") || t.includes("\\")) bad();
          return t;
        }
      }
    }
  }
  return "xl/worksheets/sheet1.xml";
}

const colIndex = (ref: string): number => {
  const m = /^([A-Z]{1,3})\d*$/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// 시트의 행 번호(1부터)를 배열 위치(행 번호 − 1)로 둔 문자열 행렬. 빈 행은 [] (줄 번호가 엑셀 화면과 같다).
export function readXlsx(buf: Buffer): XlsxRead {
  try {
    if (buf.length > XLSX_MAX_BYTES) return fail("xlsx_too_large");
    if (buf.length < 22) return fail("invalid_xlsx");
    const entries = readEntries(buf);
    const sheet = entries.get(firstSheetPath(buf, entries));
    if (!sheet) return fail("invalid_xlsx");
    const strings = sharedStrings(buf, entries);
    const xml = xmlText(readData(buf, sheet, MAX_SHEET_BYTES));
    const rows: string[][] = [];
    let rowNo = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = attrs(rm[1]);
      rowNo = ra.r && /^\d+$/.test(ra.r) ? Number(ra.r) : rowNo + 1;
      const cells: string[] = [];
      let colNo = -1;
      for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]);
        colNo = ca.r ? colIndex(ca.r) : colNo + 1;
        const body = cm[2] ?? "";
        const type = ca.t ?? "n";
        let value = "";
        if (type === "inlineStr") value = textRuns(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else {
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (v !== undefined) {
            const raw = decode(v).trim();
            if (type === "s") {
              const i = /^\d+$/.test(raw) ? Number(raw) : -1;
              if (i < 0 || i >= strings.length) bad();
              value = strings[i];
            } else if (type === "b") value = raw === "1" ? "TRUE" : "FALSE";
            else value = raw;
          }
        }
        if (value === "" || colNo < 0 || colNo >= MAX_COLS) continue;
        if (value.length > MAX_CELL_CHARS) bad();
        if (rowNo > XLSX_MAX_ROW_NUMBER) return fail("too_many_rows");
        cells[colNo] = value;
      }
      if (cells.length === 0) continue;
      for (let i = 0; i < cells.length; i++) cells[i] ??= "";
      rows[rowNo - 1] = cells;
    }
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    return { ok: true, rows };
  } catch (e) {
    if (e instanceof Bad) return fail(e.reason);
    return fail("invalid_xlsx");
  }
}

// ───────────── 쓰기 ─────────────

const xmlEscape = (s: string) =>
  // XML에 넣을 수 없는 제어 문자는 뺀다
  s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// 정수처럼 보이는 값(앞자리 0 없음, 15자리까지)은 숫자 칸으로, 나머지는 글자 칸으로 쓴다
const isPlainInt = (s: string) => /^-?(0|[1-9]\d{0,14})$/.test(s);

function sheetXml(rows: string[][]): string {
  const body = rows
    .map((cells, r) => {
      const cs = cells
        .map((v, c) => {
          if (v === "") return "";
          const ref = `${colName(c)}${r + 1}`;
          return isPlainInt(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 이름
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// 행렬을 시트 하나짜리 .xlsx로 쓴다(맨 위 줄이 열 이름). 시트 이름은 31자·특수문자 제한이 있어 걸러 쓴다.
export function writeXlsx(rows: string[][], sheetName = "Sheet1"): Buffer {
  const name = xmlEscape(sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet1");
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(`${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/workbook.xml", data: Buffer.from(`${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(`${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`) },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml(rows)) },
  ]);
}
