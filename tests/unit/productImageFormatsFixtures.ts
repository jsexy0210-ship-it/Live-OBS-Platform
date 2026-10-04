// 상품 사진 형식 시험용 JPG·WEBP(그림 데이터는 풀지 않으므로 구조만 맞춘 바이트)
const seg = (marker: number, body: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
};
export const GPS_EXIF = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("MM\0*GPSLatitude 37.5665 GPSLongitude 126.9780", "latin1")]);

export function jpeg(width: number, height: number, opts: { exif?: boolean; comment?: boolean; xmp?: boolean; trailer?: Buffer; noEoi?: boolean; noSof?: boolean } = {}): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  const parts = [
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...(opts.exif === false ? [] : [seg(0xe1, GPS_EXIF)]),
    ...(opts.xmp ? [seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS</x:xmpmeta>", "latin1"))] : []),
    seg(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01profile", "latin1")),
    ...(opts.comment ? [seg(0xfe, Buffer.from("made at home 37.5,126.9", "latin1"))] : []),
    seg(0xdb, Buffer.alloc(65, 1)),
    ...(opts.noSof ? [] : [seg(0xc0, sof)]),
    seg(0xc4, Buffer.alloc(20, 2)),
    seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    // 그림 데이터: 바이트 채움(FF 00)과 재시작 마커(FF D0)를 섞는다
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]),
    ...(opts.noEoi ? [] : [Buffer.from([0xff, 0xd9])]),
    ...(opts.trailer ? [opts.trailer] : []),
  ];
  return Buffer.concat(parts);
}

const chunk = (fourcc: string, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, "latin1");
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
export function webp(width: number, height: number, opts: { exif?: boolean; lossless?: boolean; animated?: boolean; badSize?: boolean } = {}): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = (opts.exif === false ? 0 : 0x08 | 0x04) | (opts.animated ? 0x02 : 0);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  let image: Buffer;
  if (opts.lossless) {
    const d = Buffer.alloc(10);
    d[0] = 0x2f;
    d.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 1);
    image = chunk("VP8L", d);
  } else {
    const d = Buffer.alloc(16);
    d.set([0x9d, 0x01, 0x2a], 3);
    d.writeUInt16LE(width, 6);
    d.writeUInt16LE(height, 8);
    image = chunk("VP8 ", d);
  }
  const body = Buffer.concat([
    chunk("VP8X", vp8x),
    image,
    ...(opts.exif === false ? [] : [chunk("EXIF", GPS_EXIF), chunk("XMP ", Buffer.from("<x:xmpmeta>GPS</x:xmpmeta>", "latin1"))]),
  ]);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4 + (opts.badSize ? 10 : 0), 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}
