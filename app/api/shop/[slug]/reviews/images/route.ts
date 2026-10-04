import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { readBodyLimited } from "../../../../../../lib/server/branding/image";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, requestMeta } from "../../../../../../lib/server/http/route";
import { REVIEW_IMAGE_MAX_BYTES } from "../../../../../../lib/server/product-reviews/image";
import { BUYER_REVIEW_MESSAGES, uploadReviewImage } from "../../../../../../lib/server/product-reviews/service";

// 리뷰 사진 올리기. 본문은 파일 바이트 그대로(화면이 JPEG로 다시 저장해 보냄). 1MB를 넘으면 끝까지 받지 않고 413.
// 서버가 JPEG·PNG 구조를 확인하고 위치 정보 등 메타데이터를 지운 뒤 저장한다. 응답 { image: { id, width, height, url } }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const bytes = await readBodyLimited(req, REVIEW_IMAGE_MAX_BYTES);
  if (!bytes) return noStore(NextResponse.json({ error: "file_too_large", message: BUYER_REVIEW_MESSAGES.file_too_large }, { status: 413 }));
  const r = await uploadReviewImage(prisma, b.scope, bytes, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_REVIEW_MESSAGES[r.reason] }, { status: r.reason === "shop_unavailable" ? 402 : 400 }));
  const { id, width, height } = r.image;
  return noStore(NextResponse.json({ image: { id, width, height, url: `/api/shop/${encodeURIComponent(slug)}/reviews/images/${id}` } }, { status: 201 }));
});
