import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement as h } from "react";
import wawoff2 from "wawoff2";
import RANGES from "./wantedSansRanges.json";

// 쇼핑몰 기본 공유 카드(1200×630 PNG, 대기열 4번 C안): 쇼핑몰 이름만 그린다. 외부 쇼핑몰 플랫폼 이름·로고는 넣지 않는다.
// 서체는 화면과 같은 원티드 산스(public/fonts/wanted-sans, SIL OFL)를 쓴다. 글자 범위별 woff2 파일(unicode-range 92개,
// 범위표 wantedSansRanges.json = styles/wanted-sans.css)에서 그릴 글자가 든 파일만 풀어 쓴다.
// 카드를 그리는 satori가 가변 서체 표(fvar 등)와 일부 글자 대체 표(GSUB)를 읽지 못해 그 표를 뺀 기본 굵기 서체로 그린다.

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
const FONT_NAME = "Wanted Sans";
const BASIC_LATIN_SPLIT = 90;
const DROP_TABLES = new Set(["fvar", "gvar", "avar", "HVAR", "MVAR", "STAT", "cvar", "GSUB", "GPOS", "GDEF"]);

const fontCache = new Map<number, Promise<Buffer>>();

// 이 글자들을 그리는 데 필요한 서체 파일 번호(기본 라틴 포함). 범위표에 없는 글자(이모지 등)는 빠진다.
export function splitsFor(text: string): number[] {
  const need = new Set<number>([BASIC_LATIN_SPLIT]);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const hit = (RANGES as [number, [number, number][]][]).find(([, rs]) => rs.some(([a, z]) => cp >= a && cp <= z));
    if (hit) need.add(hit[0]);
  }
  return [...need].sort((a, b) => a - b);
}

function loadSplit(n: number): Promise<Buffer> {
  let p = fontCache.get(n);
  if (!p) {
    p = readFile(path.join(process.cwd(), "public/fonts/wanted-sans/split", `WantedSansVariable.split.${n}.woff2`))
      .then(async (woff2) => withoutTables(Buffer.from(await wawoff2.decompress(woff2)), DROP_TABLES));
    // 실패한 읽기는 캐시에 남기지 않는다(다음 요청이 다시 읽음)
    p.catch(() => fontCache.delete(n));
    fontCache.set(n, p);
  }
  return p;
}

// TrueType(sfnt) 파일에서 지정한 표를 뺀 새 파일. 표 디렉터리를 다시 쓰고 각 표를 4바이트 경계로 맞춘다(표 내용·체크섬은 그대로).
export function withoutTables(font: Buffer, drop: ReadonlySet<string>): Buffer {
  const count = font.readUInt16BE(4);
  const tables = Array.from({ length: count }, (_, i) => {
    const o = 12 + i * 16;
    return { tag: font.toString("latin1", o, o + 4), checksum: font.readUInt32BE(o + 4), offset: font.readUInt32BE(o + 8), length: font.readUInt32BE(o + 12) };
  }).filter((t) => !drop.has(t.tag));
  const headerSize = 12 + tables.length * 16;
  const out = Buffer.alloc(tables.reduce((n, t) => n + ((t.length + 3) & ~3), headerSize));
  font.copy(out, 0, 0, 4);
  out.writeUInt16BE(tables.length, 4);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= tables.length) {
    pow *= 2;
    log++;
  }
  out.writeUInt16BE(pow * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(tables.length * 16 - pow * 16, 10);
  let at = headerSize;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    out.write(t.tag, o, "latin1");
    out.writeUInt32BE(t.checksum, o + 4);
    out.writeUInt32BE(at, o + 8);
    out.writeUInt32BE(t.length, o + 12);
    font.copy(out, at, t.offset, t.offset + t.length);
    at += (t.length + 3) & ~3;
  });
  return out;
}

// 쇼핑몰 이름 길이에 맞춘 글자 크기(이름은 50자까지)
const nameSize = (name: string) => {
  const n = [...name].length;
  return n <= 10 ? 96 : n <= 20 ? 72 : n <= 32 ? 56 : 44;
};

export async function renderShopOgCard(shopName: string): Promise<Buffer> {
  const fonts = await Promise.all(
    splitsFor(`${shopName}ONQ`).map(async (n) => ({ name: FONT_NAME, data: await loadSplit(n), weight: 400 as const, style: "normal" as const })),
  );
  const card = h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "88px 96px",
        background: "#101114",
        color: "#ffffff",
        fontFamily: FONT_NAME,
      },
    },
    h("div", { style: { display: "flex", fontSize: nameSize(shopName), lineHeight: 1.25, wordBreak: "keep-all" } }, shopName),
    h("div", { style: { display: "flex", fontSize: 32, color: "#8b8f98" } }, "ONQ"),
  );
  const res = new ImageResponse(card, { width: OG_WIDTH, height: OG_HEIGHT, fonts });
  return Buffer.from(await res.arrayBuffer());
}
