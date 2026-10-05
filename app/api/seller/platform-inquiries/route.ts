import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { createInquiry, inquiryStatus, listMyInquiries, PLATFORM_INQUIRY_MESSAGES } from "../../../../lib/server/platform-inquiries/service";

// 내 문의 목록(SA-113). 파트너스 계정 누구나, 잠김·정지 중에도. 대표자는 쇼핑몰 문의 전부, 직원은 자기가 쓴 것만.
// ?cursor= → { items: [{ id, category, title, status, createdAt, lastMessageAt, authorName, hasNewReply }], nextCursor }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const r = await listMyInquiries(prisma, ctx, { cursor: new URL(req.url).searchParams.get("cursor") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(NextResponse.json({ items: r.items, nextCursor: r.nextCursor }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 문의 보내기(SA-114). 본문 { category: BILLING|ACCOUNT|FEATURE|BUG|OTHER, title, body, imageIds?: 최대 5, noticeId? }.
// 201 { inquiry } · 400 invalid_* · 429 too_many_inquiries(쇼핑몰당 24시간 20건)
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await createInquiry(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ inquiry: r.inquiry }, { status: 201 }));
});
