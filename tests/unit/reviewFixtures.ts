// 리뷰 사진 시험용 JPEG(디코더 없이 구조만 맞춤)
export const seg = (marker: number, payload: Buffer) => {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
};
export function fakeJpeg(width: number, height: number, withExif = false): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    ...(withExif ? [seg(0xe1, Buffer.from("Exif\0\0GPSLatitude 37.5665 GPSLongitude 126.9780", "latin1"))] : []),
    seg(0xfe, Buffer.from("comment", "latin1")),
    seg(0xc0, sof),
    seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// progressive처럼 스캔이 여러 개인 JPEG. 스캔 사이에 DHT와 함께 EXIF(APP1)·주석(COM)이 끼어 있고, 엔트로피 데이터에 재시작 마커(FFD0)가 있다.
export function multiScanJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    seg(0xc2, sof),
    sos,
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    seg(0xc4, Buffer.from([0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    seg(0xe1, Buffer.from("Exif\0\0GPSLatitude 37.5665 GPSLongitude 126.9780", "latin1")),
    seg(0xfe, Buffer.from("between scans", "latin1")),
    sos,
    Buffer.from([0x78, 0x9a]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
