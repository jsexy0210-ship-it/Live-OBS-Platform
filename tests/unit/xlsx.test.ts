import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { XLSX_MAX_BYTES, readXlsx, writeXlsx } from "../../lib/server/shop-bulk-io/xlsx";

// 엑셀(.xlsx) 최소 읽기·쓰기(SA-018). 업로드 파일은 믿지 않는다: 압축 폭탄·경로 순회·암호화·중복 이름·엔티티 폭발·크기 거짓말을 막는다.
type E = { name: string; data?: Buffer; stored?: boolean; comp?: Buffer; crc?: number; size?: number; flags?: number; offset?: number };
function buildZip(entries: E[], opts: { eocdTotal?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const comp = e.comp ?? (e.stored ? data : deflateRawSync(data));
    const name = Buffer.from(e.name);
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(e.flags ?? 0, 8);
    c.writeUInt16LE(e.stored ? 0 : 8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(e.offset ?? offset, 42);
    centrals.push(c, name);
    offset += local.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.eocdTotal ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const sheet = (rowsXml: string) => Buffer.from(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`);
const simple = (rowsXml: string, extra: E[] = []) => buildZip([{ name: "xl/worksheets/sheet1.xml", data: sheet(rowsXml) }, ...extra]);
const rows = (r: ReturnType<typeof readXlsx>) => {
  if (!r.ok) throw new Error(r.reason);
  return r.rows;
};

describe("쓰기 → 읽기", () => {
  it("글자·숫자·한글·특수문자·앞자리 0·빈 칸이 그대로 돌아온다", () => {
    const data = [
      ["상품명", "판매가", "설명", "SKU"],
      ["부스터 <팩> & \"세트\"", "5000", "첫 줄\n둘째 줄", "00123"],
      ["", "-30", "", "BP-1"],
      ["끝", "", "", ""],
    ];
    const got = rows(readXlsx(writeXlsx(data, "상품: 목록/시트")));
    expect(got[0]).toEqual(["상품명", "판매가", "설명", "SKU"]);
    expect(got[1]).toEqual(["부스터 <팩> & \"세트\"", "5000", "첫 줄\n둘째 줄", "00123"]);
    expect(got[2]).toEqual(["", "-30", "", "BP-1"]);
    expect(got[3]).toEqual(["끝"]);
    // 제어 문자는 빠진다
    expect(rows(readXlsx(writeXlsx([["a\u0001b"]])))[0][0]).toBe("ab");
  });
});

describe("읽기: 엑셀이 실제로 만드는 모양", () => {
  it("공유 문자열(서식 있는 글자·엔티티)·인라인 문자열·수식 결과·참거짓·건너뛴 칸과 빈 행의 위치", () => {
    const strings = Buffer.from(
      `<sst><si><t>상품명</t></si><si><r><t>빨강 </t></r><r><rPr/><t>부스터</t></r><rPh><t>ぶすた</t></rPh></si><si><t xml:space="preserve"> A &amp; B &lt;1&gt; &#44;&#x2c;</t></si></sst>`,
    );
    const body =
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>` +
      `<row r="3"><c r="A3" t="inlineStr"><is><t>인라인</t></is></c><c r="B3"><f>1+2</f><v>3</v></c><c r="C3" t="str"><f>"x"</f><v>결과</v></c><c r="D3" t="b"><v>1</v></c><c r="E3" t="s"><v>2</v></c></row>` +
      `<row r="5"/><row r="6"><c r="B6"><v>24000</v></c></row><row r="1000000"><c r="A1000000" s="3"/></row>`;
    const got = rows(readXlsx(simple(body, [{ name: "xl/sharedStrings.xml", data: strings }])));
    expect(got[0]).toEqual(["상품명", "", "빨강 부스터"]);
    expect(got[1]).toEqual([]);
    expect(got[2]).toEqual(["인라인", "3", "결과", "TRUE", " A & B <1> ,,"]);
    expect(got[3]).toEqual([]);
    expect(got[4]).toEqual([]);
    expect(got[5]).toEqual(["", "24000"]);
    expect(got).toHaveLength(6);
  });

  it("workbook.xml·rels의 첫 시트를 따라가고, 없으면 sheet1.xml을 쓴다", () => {
    const wb = Buffer.from(`<workbook xmlns:r="x"><sheets><sheet name="첫째" sheetId="2" r:id="rId9"/><sheet name="둘째" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    const rels = Buffer.from(`<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="t" Target="/xl/worksheets/sheet2.xml"/></Relationships>`);
    const zipped = buildZip([
      { name: "xl/workbook.xml", data: wb },
      { name: "xl/_rels/workbook.xml.rels", data: rels },
      { name: "xl/worksheets/sheet1.xml", data: sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>둘째 시트</t></is></c></row>`) },
      { name: "xl/worksheets/sheet2.xml", data: sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>첫 시트</t></is></c></row>`) },
    ]);
    expect(rows(readXlsx(zipped))[0][0]).toBe("첫 시트");
    expect(rows(readXlsx(simple(`<row r="1"><c r="A1" t="inlineStr"><is><t>기본</t></is></c></row>`)))[0][0]).toBe("기본");
    const stored = buildZip([{ name: "xl/worksheets/sheet1.xml", data: sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>저장</t></is></c></row>`), stored: true }]);
    expect(rows(readXlsx(stored))[0][0]).toBe("저장");
  });
});

describe("읽기: 잘못된 파일·공격", () => {
  const cell = `<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`;
  const reason = (b: Buffer) => {
    const r = readXlsx(b);
    return r.ok ? "ok" : r.reason;
  };

  it("zip이 아니거나 잘렸거나 비어 있으면 invalid_xlsx", () => {
    expect(reason(Buffer.alloc(0))).toBe("invalid_xlsx");
    expect(reason(Buffer.from("상품명,판매가\n부스터,5000"))).toBe("invalid_xlsx");
    const good = writeXlsx([["a"]]);
    expect(reason(good.subarray(0, good.length - 30))).toBe("invalid_xlsx");
    expect(reason(buildZip([]))).toBe("invalid_xlsx");
    expect(reason(simple(cell).subarray(10))).toBe("invalid_xlsx");
  });

  it("5MB를 넘으면 xlsx_too_large", () => {
    expect(reason(Buffer.alloc(XLSX_MAX_BYTES + 1))).toBe("xlsx_too_large");
  });

  it("암호화·zip64 표시·같은 이름 두 번·경로를 벗어나는 이름·역슬래시 이름은 거부", () => {
    const sheetE = { name: "xl/worksheets/sheet1.xml", data: sheet(cell) };
    expect(reason(buildZip([{ ...sheetE, flags: 1 }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([{ ...sheetE, size: 0xffffffff }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([sheetE], { eocdTotal: 0xffff }))).toBe("invalid_xlsx");
    expect(reason(buildZip([sheetE, sheetE]))).toBe("invalid_xlsx");
    expect(reason(buildZip([sheetE, { name: "../evil.xml", data: Buffer.from("x") }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([sheetE, { name: "xl/../../evil", data: Buffer.from("x") }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([sheetE, { name: "/abs/evil", data: Buffer.from("x") }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([sheetE, { name: "a\\b", data: Buffer.from("x") }]))).toBe("invalid_xlsx");
    // rels가 가리키는 시트 경로가 위로 올라가도 거부
    const wb = Buffer.from(`<workbook xmlns:r="x"><sheets><sheet name="a" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    const rels = Buffer.from(`<Relationships><Relationship Id="rId1" Type="t" Target="../../etc/passwd"/></Relationships>`);
    expect(reason(buildZip([{ name: "xl/workbook.xml", data: wb }, { name: "xl/_rels/workbook.xml.rels", data: rels }, sheetE]))).toBe("invalid_xlsx");
  });

  it("압축 폭탄: 선언 크기보다 크게 풀리면 중단하고, 선언이 한도를 넘으면 푸는 시도도 하지 않는다", () => {
    const huge = Buffer.alloc(40 * 1024 * 1024, 0x20); // 풀면 40MB, 압축하면 작다
    const comp = deflateRawSync(huge);
    expect(comp.length).toBeLessThan(200_000);
    // 선언은 100바이트인데 실제로는 40MB
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", comp, crc: crc32(huge), size: 100 }]))).toBe("invalid_xlsx");
    // 선언이 시트 한도(32MB) 초과
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", comp, crc: crc32(huge), size: huge.length }]))).toBe("xlsx_too_large");
    // 항목 선언 합계가 64MB 초과
    const parts = [0, 1, 2].map((i) => ({ name: `x/${i}`, comp: Buffer.alloc(1), crc: 0, size: 30 * 1024 * 1024 }));
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", data: sheet(cell) }, ...parts]))).toBe("xlsx_too_large");
  });

  it("크기·CRC가 선언과 다르면 거부", () => {
    const data = sheet(cell);
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", data, crc: 123 }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", data, size: data.length + 5 }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", data, stored: true, size: data.length - 1 }]))).toBe("invalid_xlsx");
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", data, offset: 9999 }]))).toBe("invalid_xlsx");
  });

  it("DOCTYPE·ENTITY가 든 XML과 범위 밖 공유 문자열 번호는 거부", () => {
    expect(reason(buildZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet><sheetData>${cell}</sheetData></worksheet>`) }]))).toBe("invalid_xlsx");
    expect(reason(simple(cell, [{ name: "xl/sharedStrings.xml", data: Buffer.from(`<!DOCTYPE sst [<!ENTITY lol "lol">]><sst><si><t>&lol;</t></si></sst>`) }]))).toBe("invalid_xlsx");
    expect(reason(simple(`<row r="1"><c r="A1" t="s"><v>5</v></c></row>`, [{ name: "xl/sharedStrings.xml", data: Buffer.from(`<sst><si><t>a</t></si></sst>`) }]))).toBe("invalid_xlsx");
    expect(reason(simple(`<row r="1"><c r="A1" t="s"><v>abc</v></c></row>`))).toBe("invalid_xlsx");
  });

  it("값이 있는 행 번호가 한도(20,000)를 넘으면 too_many_rows, 값 없는 서식 행은 무시", () => {
    expect(reason(simple(`<row r="20001"><c r="A20001" t="inlineStr"><is><t>x</t></is></c></row>`))).toBe("too_many_rows");
    expect(reason(simple(`${cell}<row r="900000"><c r="A900000"/></row>`))).toBe("ok");
    expect(rows(readXlsx(simple(`<row r="20000"><c r="A20000" t="inlineStr"><is><t>x</t></is></c></row>`)))).toHaveLength(20000);
  });

  it("엔티티는 미리 정해진 다섯 가지와 숫자 참조만 풀고, 잘못된 숫자 참조는 지운다", () => {
    const got = rows(readXlsx(simple(`<row r="1"><c r="A1" t="inlineStr"><is><t>&amp;lt; &#0; &#xD800; &#1114112; &unknown; &#65;</t></is></c></row>`)));
    expect(got[0][0]).toBe("&lt;    &unknown; A");
  });
});
