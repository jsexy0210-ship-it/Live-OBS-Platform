// 상품 사진 JPG·WEBP 처리(MASTER 결정 2026-10-04, 디코더·새 의존성 없이). 그림 데이터는 풀지 않고 파일 구조만 따라가며,
// 위치정보(EXIF GPS)·편집 정보가 남지 않게 메타데이터 구간을 잘라 낸 바이트를 저장한다. 구조가 어긋나면 null(거절).
// - JPG: SOI부터 마커를 차례로 읽는다. APP1(EXIF·XMP)·APP13(IPTC)·APP3~APP12·APP15·COM은 버리고, APP0(JFIF)·APP2(ICC 색 정보)·
//   APP14(Adobe 색 변환)·표·SOF·SOS와 그림 데이터는 그대로 둔다. EOI 뒤에 붙은 바이트는 버린다. SOF·SOS·EOI가 없으면 거절.
// - WEBP: RIFF 머리 크기가 파일과 맞아야 하고, 청크를 차례로 읽어 EXIF·XMP 청크를 빼고 VP8X의 해당 표시를 끈 뒤 RIFF 크기를 고친다.
//   움직이는 WEBP(ANIM)는 받지 않는다.
// sharp 같은 디코더로 다시 인코딩하는 방식은 인프라 저장소 단계에서 검토한다.

export type StrippedImage = { bytes: Buffer; width: number; height: number };

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const KEEP_APP = new Set([0xe0, 0xe2, 0xee]); // APP0 JFIF, APP2 ICC, APP14 Adobe

export const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
export const isWebp = (b: Buffer) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";

export function stripJpeg(b: Buffer): StrippedImage | null {
  if (!isJpeg(b)) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  let size: { width: number; height: number } | null = null;
  let scanned = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // 채움 바이트
    if (i >= b.length) return null;
    const marker = b[i++];
    if (marker === 0xd9) {
      // EOI: 뒤에 붙은 바이트는 버린다
      if (!size || !scanned) return null;
      out.push(Buffer.from([0xff, 0xd9]));
      return { bytes: Buffer.concat(out), ...size };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null; // 스캔 밖의 길이 없는 마커는 이상한 구조
    if (marker === 0xd8 || marker === 0x00) return null;
    if (i + 2 > b.length) return null;
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) return null;
    const segment = b.subarray(i - 2, i + len);
    if (SOF.has(marker)) {
      if (len < 8 || size) return null;
      const height = b.readUInt16BE(i + 3);
      const width = b.readUInt16BE(i + 5);
      if (!width || !height) return null;
      size = { width, height };
    }
    const metadata = (marker >= 0xe0 && marker <= 0xef && !KEEP_APP.has(marker)) || marker === 0xfe;
    if (!metadata) out.push(segment);
    i += len;
    if (marker === 0xda) {
      if (!size) return null;
      // 그림 데이터: 다음 마커(FF 뒤가 00·RST가 아닌 것)까지 그대로
      const start = i;
      while (i + 1 < b.length && !(b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7))) i++;
      if (i + 1 >= b.length) return null;
      out.push(b.subarray(start, i));
      scanned = true;
    }
  }
  return null;
}

export function stripWebp(b: Buffer): StrippedImage | null {
  if (!isWebp(b) || b.readUInt32LE(4) !== b.length - 8) return null;
  const chunks: Buffer[] = [];
  let i = 12;
  let size: { width: number; height: number } | null = null;
  let vp8xIndex = -1;
  let image = false;
  while (i < b.length) {
    if (i + 8 > b.length) return null;
    const fourcc = b.toString("latin1", i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (end > b.length) return null;
    const data = b.subarray(i + 8, i + 8 + len);
    if (fourcc === "VP8X") {
      if (len < 10 || vp8xIndex >= 0 || chunks.length > 0) return null;
      if (data[0] & 0x02) return null; // 움직이는 WEBP
      size = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
      vp8xIndex = chunks.length;
    } else if (fourcc === "VP8 ") {
      if (len < 10 || image || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
      const s = { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
      size ??= s;
      image = true;
    } else if (fourcc === "VP8L") {
      if (len < 5 || image || data[0] !== 0x2f) return null;
      const bits = data.readUInt32LE(1);
      const s = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      size ??= s;
      image = true;
    } else if (fourcc === "ANIM" || fourcc === "ANMF") {
      return null;
    }
    if (fourcc !== "EXIF" && fourcc !== "XMP ") chunks.push(b.subarray(i, end));
    i = end;
  }
  if (!image || !size || !size.width || !size.height) return null;
  if (vp8xIndex >= 0) {
    const x = Buffer.from(chunks[vp8xIndex]);
    x[8] &= ~(0x08 | 0x04); // EXIF·XMP 표시 끄기
    chunks[vp8xIndex] = x;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return { bytes: Buffer.concat([head, body]), ...size };
}
