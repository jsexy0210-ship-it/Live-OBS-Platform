import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { readBodyLimited } from "../../../../../../lib/server/branding/image";
import { prisma } from "../../../../../../lib/server/db";
import { BUYER_INQUIRY_MESSAGES, inquiryStatus, uploadInquiryImage } from "../../../../../../lib/server/buyer-inquiries/service";
import { mutation, noStore, requestMeta } from "../../../../../../lib/server/http/route";
import { REVIEW_IMAGE_MAX_BYTES } from "../../../../../../lib/server/product-reviews/image";

// 문의 사진 올리기. 본문은 파일 바이트 그대로(JPG·PNG·WEBP, 5MB, 위치 정보 제거). 응답 201 { image: { id, width, height, url } }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const bytes = await readBodyLimited(req, REVIEW_IMAGE_MAX_BYTES);
  if (!bytes) return noStore(NextResponse.json({ error: "file_too_large", message: BUYER_INQUIRY_MESSAGES.file_too_large }, { status: 413 }));
  const r = await uploadInquiryImage(prisma, b.scope, bytes, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  const { id, width, height } = r.image;
  return noStore(NextResponse.json({ image: { id, width, height, url: `/api/shop/${encodeURIComponent(slug)}/inquiries/images/${id}` } }, { status: 201 }));
});
