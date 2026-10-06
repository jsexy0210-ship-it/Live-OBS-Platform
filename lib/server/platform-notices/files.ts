import { cleanFileNameWith, FILE_MAX_BYTES } from "../platform-inquiries/files";
import { checkReviewImage } from "../product-reviews/image";

// 공지 첨부 파일(MA-053·054): .png·.jpg(.jpeg)·.pdf만, 파일당 5MB·공지당 5개. 올리는 쪽은 공지 작성 권한자(support.manage), 파트너스는 받기만.
// - 사진은 리뷰 사진과 같은 검사(실제 그림인지, 위치 정보 등 메타데이터 제거, 허용 크기)를 거쳐 png·jpeg로 저장한다(webp 등은 거부).
// - PDF는 앞머리가 %PDF-인 파일만. 내용은 열어 보지 않는다. 받기는 항상 attachment·nosniff(문의 첨부와 같은 규칙, 응답은 inquiryFileResponse).
export const NOTICE_FILE_MAX_BYTES = FILE_MAX_BYTES;
export const NOTICE_FILES_PER_NOTICE = 5;

const EXTS = [".png", ".jpg", ".jpeg", ".pdf"] as const;
export type NoticeFileCheck = { ok: true; name: string; contentType: string; data: Buffer } | { ok: false; reason: "unsupported_file" };

export function checkNoticeFile(rawName: unknown, bytes: Buffer): NoticeFileCheck {
  const n = cleanFileNameWith(rawName, EXTS);
  if (!n || bytes.length === 0 || bytes.length > NOTICE_FILE_MAX_BYTES) return { ok: false, reason: "unsupported_file" };
  if (n.ext === ".pdf") {
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return { ok: false, reason: "unsupported_file" };
    return { ok: true, name: n.name, contentType: "application/pdf", data: bytes };
  }
  const img = checkReviewImage(bytes);
  if (!img.ok || img.image.type === "image/webp") return { ok: false, reason: "unsupported_file" };
  // 확장자와 실제 그림 종류가 다르면 이름의 확장자를 실제 종류에 맞춘다
  const ext = img.image.type === "image/png" ? ".png" : ".jpg";
  const name = n.ext === ext || (ext === ".jpg" && n.ext === ".jpeg") ? n.name : n.name.slice(0, n.name.length - n.ext.length) + ext;
  return { ok: true, name, contentType: img.image.type, data: img.image.data };
}
