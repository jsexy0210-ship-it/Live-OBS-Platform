import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { BUYER_INQUIRY_MESSAGES, deleteInquiry, getMyInquiry, inquiryStatus, updateInquiry } from "../../../../../../lib/server/buyer-inquiries/service";
import { errorResponse, mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

type Ctx = { params: Promise<{ slug: string; inquiryId: string }> };

// 내 문의 하나(없거나 남의 것이면 404)
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { slug, inquiryId } = await params;
    const b = await buyerScope(req, slug);
    if (!b.scope) return noStore(b.res);
    const v = await getMyInquiry(prisma, b.scope, inquiryId, `/api/shop/${encodeURIComponent(slug)}/inquiries/images`);
    return noStore(v ? NextResponse.json({ inquiry: v }) : NextResponse.json({ error: "inquiry_not_found", message: BUYER_INQUIRY_MESSAGES.inquiry_not_found }, { status: 404 }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 고치기(답변 전만). 본문은 쓰기와 같다(kind·productId는 바꾸지 않음). 답변이 달렸으면 409.
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, inquiryId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await updateInquiry(prisma, b.scope, inquiryId, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ ok: true }));
});

// 지우기(답변 전만, 사진도 함께 지움). 답변이 달렸으면 409.
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, inquiryId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await deleteInquiry(prisma, b.scope, inquiryId, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ ok: true }));
});
