import { NextResponse } from "next/server";
import { readBodyLimited } from "../../../../../../lib/server/branding/image";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, requestMeta } from "../../../../../../lib/server/http/route";
import { REVIEW_IMAGE_MAX_BYTES } from "../../../../../../lib/server/product-reviews/image";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { uploadReturnImage } from "../../../../../../lib/server/shop-returns/service";

// 신청 사진 올리기. 본문은 파일 바이트 그대로. 5MB를 넘으면 끝까지 받지 않고 413. 서버가 형식을 확인하고 위치 정보 등을 지운다(리뷰 사진과 같은 검사).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const bytes = await readBodyLimited(req, REVIEW_IMAGE_MAX_BYTES);
  if (!bytes) return noStore(returnError("file_too_large", "buyer"));
  const r = await uploadReturnImage(prisma, b.scope, bytes, requestMeta(req));
  if (!r.ok) return noStore(returnError(r.reason, "buyer"));
  const { id, width, height } = r.image;
  return noStore(NextResponse.json({ image: { id, width, height, url: `/api/shop/${encodeURIComponent(slug)}/returns/images/${id}` } }, { status: 201 }));
});
