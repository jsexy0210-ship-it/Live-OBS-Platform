import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../../lib/server/branding/image";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { inquiryStatus, PLATFORM_INQUIRY_MESSAGES, uploadInquiryImage } from "../../../../../lib/server/platform-inquiries/service";
import { REVIEW_IMAGE_MAX_BYTES } from "../../../../../lib/server/product-reviews/image";

// 문의 첨부 사진 올리기(보내기 전). 본문은 파일 바이트 그대로. 5MB를 넘으면 끝까지 받지 않고 413. 리뷰 사진과 같은 검사·위치 정보 제거.
// 201 { image: { id, width, height, url } } → 보낼 때 imageIds에 넣는다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const bytes = await readBodyLimited(req, REVIEW_IMAGE_MAX_BYTES);
  if (!bytes) return noStore(NextResponse.json({ error: "file_too_large", message: PLATFORM_INQUIRY_MESSAGES.file_too_large }, { status: 413 }));
  const r = await uploadInquiryImage(prisma, ctx, bytes, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  const { id, width, height } = r.image;
  return noStore(NextResponse.json({ image: { id, width, height, url: `/api/seller/platform-inquiries/images/${id}` } }, { status: 201 }));
});
