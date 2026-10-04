import { describe, expect, it } from "vitest";
import { checkReviewImage, hasImageMetadata, stripJpeg, stripPng } from "../../lib/server/product-reviews/image";
import { heldReason, parsePolicy, parseReview, rewardFor } from "../../lib/server/product-reviews/rules";
import { png } from "./shopContentFixtures";
import { fakeJpeg, multiScanJpeg, seg } from "./reviewFixtures";

// 상품 리뷰: 입력 검사·자동 보류·사진 검사(JPEG·PNG, 메타데이터 제거)
describe("리뷰 사진 검사", () => {
  it("JPEG 크기를 읽고 EXIF(APP1)·주석(COM)을 지운다. APP0(JFIF)과 그림 데이터는 남긴다", () => {
    const src = fakeJpeg(1200, 900, true);
    expect(hasImageMetadata(src)).toBe(true);
    const r = checkReviewImage(src);
    expect(r.ok && [r.image.type, r.image.width, r.image.height]).toEqual(["image/jpeg", 1200, 900]);
    if (!r.ok) return;
    expect(hasImageMetadata(r.image.data)).toBe(false);
    expect(r.image.data.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(r.image.data.includes(Buffer.from("JFIF"))).toBe(true);
    expect(r.image.data.subarray(-7).equals(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]))).toBe(true);
  });

  it("스캔 사이에 끼어든 EXIF·주석도 파일 끝(EOI)까지 지우고, 스캔 데이터·재시작 마커·DHT는 남긴다(Codex 4176882130)", () => {
    const src = multiScanJpeg(1200, 900);
    expect(hasImageMetadata(src)).toBe(true);
    const r = checkReviewImage(src);
    expect(r.ok && [r.image.width, r.image.height]).toEqual([1200, 900]);
    if (!r.ok) return;
    const out = r.image.data;
    expect(hasImageMetadata(out)).toBe(false);
    expect(out.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(out.includes(Buffer.from("between scans"))).toBe(false);
    expect(out.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]))).toBe(true);
    expect(out.includes(Buffer.from([0xff, 0xc4]))).toBe(true);
    expect(out.subarray(-4).equals(Buffer.from([0x78, 0x9a, 0xff, 0xd9]))).toBe(true);
    // EOI 뒤에 붙은 바이트(숨긴 데이터)는 버린다
    const tail = checkReviewImage(Buffer.concat([src, Buffer.from("Exif\0\0GPS trailer", "latin1")]));
    expect(tail.ok && tail.image.data.includes(Buffer.from("trailer"))).toBe(false);
    // 스캔 사이 마커가 깨졌으면 저장하지 않고 거절
    const broken = Buffer.from(src);
    broken.writeUInt16BE(0xffff, src.indexOf(Buffer.from("Exif")) - 2);
    expect(checkReviewImage(broken)).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("깨진 JPEG(SOF 없음·EOI 없음·길이 넘침)는 거부한다", () => {
    const ok = fakeJpeg(100, 100);
    expect(stripJpeg(ok.subarray(0, ok.length - 2))).toBeNull();
    const noSof = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0xff, 0xd9])]);
    expect(stripJpeg(noSof)).toBeNull();
    const bad = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]);
    expect(checkReviewImage(bad)).toEqual({ ok: false, reason: "unsupported_image" });
  });

  it("크기: 긴 변 1600px까지, 1MB까지, 빈 파일 거부", () => {
    expect(checkReviewImage(fakeJpeg(1601, 100))).toEqual({ ok: false, reason: "wrong_image_size" });
    expect(checkReviewImage(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_file" });
    expect(checkReviewImage(Buffer.alloc(1024 * 1024 + 1, 1))).toEqual({ ok: false, reason: "file_too_large" });
  });

  it("PNG는 공용 PNG 검사를 거치고 텍스트·eXIf 덩어리를 지운다", () => {
    const src = png(400, 300);
    // IEND 앞에 tEXt 덩어리를 끼운다(CRC는 검사기가 보지 않는 보조 덩어리)
    const iend = src.length - 12;
    const text = Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from("tEXtGPS\0x=1", "latin1"), Buffer.alloc(4)]);
    const withText = Buffer.concat([src.subarray(0, iend), text, src.subarray(iend)]);
    expect(hasImageMetadata(withText)).toBe(true);
    const stripped = stripPng(withText);
    expect(stripped).not.toBeNull();
    expect(hasImageMetadata(stripped!)).toBe(false);
    expect(stripped!.length).toBe(src.length);
    const r = checkReviewImage(src);
    expect(r.ok && [r.image.type, r.image.width, r.image.height]).toEqual(["image/png", 400, 300]);
    expect(checkReviewImage(png(1700, 100))).toEqual({ ok: false, reason: "wrong_image_size" });
  });
});

describe("리뷰 입력", () => {
  it("별점 1~5 정수, 본문 10~1000자, 사진 5장·중복 없음", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseReview({ rating: 0, body: "열 글자가 넘는 리뷰입니다" }, 5)).toEqual({ ok: false, reason: "invalid_rating" });
    expect(parseReview({ rating: 4.5, body: "열 글자가 넘는 리뷰입니다" }, 5)).toEqual({ ok: false, reason: "invalid_rating" });
    expect(parseReview({ rating: 5, body: "짧아요" }, 5)).toEqual({ ok: false, reason: "invalid_body" });
    expect(parseReview({ rating: 5, body: "가".repeat(1001) }, 5)).toEqual({ ok: false, reason: "invalid_body" });
    expect(parseReview({ rating: 5, body: "열 글자가 넘는 리뷰입니다", imageIds: [id, id] }, 5)).toEqual({ ok: false, reason: "invalid_images" });
    const r = parseReview({ rating: 5, body: "  포장이 꼼꼼하고\n배송도 빨랐어요  " }, 5);
    expect(r.ok && r.v).toEqual({ rating: 5, body: "포장이 꼼꼼하고\n배송도 빨랐어요", imageIds: [] });
  });

  it("자동 보류: 연락처·외부 주소·메신저 아이디·판매자 금지어", () => {
    expect(heldReason("문의는 010-1234-5678로 주세요", [])).toBe("contact");
    expect(heldReason("카톡 아이디: star_card 로 연락", [])).toBe("contact");
    expect(heldReason("더 싸게 파는 곳 www.example.com 참고", [])).toBe("url");
    expect(heldReason("여기 사기꾼이에요 조심", ["사기"])).toBe("banned_word");
    expect(heldReason("카드 상태가 정말 좋았어요. 2만 원에 샀어요", ["사기"])).toBeNull();
  });

  it("설정: 적립금 0~10만 원, 기간 1~365일, 금지어 20자·50개, 중복 금지어는 하나로", () => {
    const ok = parsePolicy({ publishMode: "REVIEW", rewardText: 500, rewardPhoto: 1000, writableDays: 30, bannedWords: ["사기", "사기", "환불 안 해줌"] });
    expect(ok.ok && ok.v.bannedWords).toEqual(["사기", "환불 안 해줌"]);
    expect(parsePolicy({ publishMode: "IMMEDIATE", rewardText: -1, rewardPhoto: 0, writableDays: 30, bannedWords: [] }).ok).toBe(false);
    expect(parsePolicy({ publishMode: "IMMEDIATE", rewardText: 0, rewardPhoto: 0, writableDays: 0, bannedWords: [] }).ok).toBe(false);
    expect(parsePolicy({ publishMode: "IMMEDIATE", rewardText: 0, rewardPhoto: 0, writableDays: 30, bannedWords: ["가".repeat(21)] }).ok).toBe(false);
    expect(rewardFor({ rewardText: 500, rewardPhoto: 1000 }, 0)).toBe(500);
    expect(rewardFor({ rewardText: 500, rewardPhoto: 1000 }, 2)).toBe(1000);
  });
});
