import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { createInquiry, BUYER_INQUIRY_MESSAGES, inquiryStatus, listMyInquiries } from "../../../../../lib/server/buyer-inquiries/service";
import { errorResponse, mutation, noStore, readJson, requestMeta } from "../../../../../lib/server/http/route";

// 내 문의 목록(?cursor, 20개씩, 응답 { inquiries, nextCursor }). 잠긴 쇼핑몰이어도 받은 답변은 본다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const b = await buyerScope(req, slug);
    if (!b.scope) return noStore(b.res);
    return noStore(NextResponse.json(await listMyInquiries(prisma, b.scope, { cursor: new URL(req.url).searchParams.get("cursor") }, `/api/shop/${encodeURIComponent(slug)}/inquiries/images`)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 문의 쓰기. 본문 { kind: "PRODUCT"|"GENERAL", productId?(상품 문의만), title(50자), body(2000자), isPrivate?, imageIds?(올린 사진 id, 5장까지) }. 응답 201 { id }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await createInquiry(prisma, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ id: r.id }, { status: 201 }));
});
