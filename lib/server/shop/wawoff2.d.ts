// wawoff2(MIT): woff2 ↔ TrueType 변환. 타입 정의가 없어 쓰는 함수만 적는다.
declare module "wawoff2" {
  const wawoff2: { decompress(woff2: Uint8Array): Promise<Uint8Array> };
  export default wawoff2;
}
