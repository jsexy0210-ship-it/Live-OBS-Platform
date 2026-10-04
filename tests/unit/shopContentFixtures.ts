import { crc32, deflateSync } from "node:zlib";

// 시험용 이미지 바이트. 실제로 풀리는 PNG(RGB 8비트, 필터 0)와 구조가 맞는 최소 JPEG를 만든다.
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function png(width: number, height: number, rgb: [number, number, number] = [91, 61, 246]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 구조가 맞는 최소 JPEG(PNG만 받는지 확인용)
export function jpeg(width: number, height: number): Buffer {
  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 1)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, sof, sos, Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0xff, 0xd9])]);
}

// PNG 머리 뒤에 SVG를 붙인 위장 파일
export const svgInPng = () => Buffer.concat([png(200, 200).subarray(0, 33), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')]);
export const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>');

// 머리는 맞지만 그림 데이터가 풀리지 않는 PNG(IDAT 내용을 망가뜨리고 CRC는 다시 맞춤)
export function brokenPng(): Buffer {
  const ok = png(200, 200);
  const ihdrEnd = 8 + 25;
  const idatLen = ok.readUInt32BE(ihdrEnd);
  const bad = Buffer.alloc(idatLen, 0xab);
  return Buffer.concat([ok.subarray(0, ihdrEnd), chunk("IDAT", bad), chunk("IEND", Buffer.alloc(0))]);
}
