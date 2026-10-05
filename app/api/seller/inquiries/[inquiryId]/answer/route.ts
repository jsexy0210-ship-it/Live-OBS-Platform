import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { answerInquiry, SELLER_INQUIRY_MESSAGES } from "../../../../../../lib/server/buyer-inquiries/service";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 문의 답변 쓰기·고치기·지우기. 본문 { answer: string(1000자) | null(지우면 답변 대기로 돌아감) }. 대표자·구매자 문의(INQUIRY_REPLY) 직원만.
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ inquiryId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await answerInquiry(prisma, ctx, (await params).inquiryId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SELLER_INQUIRY_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ ok: true });
});
