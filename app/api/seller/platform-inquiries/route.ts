import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { createInquiry, inquiryStatus, listMyInquiries, PLATFORM_INQUIRY_MESSAGES } from "../../../../lib/server/platform-inquiries/service";

// 내 문의 목록(SA-113). 파트너스 계정 누구나, 잠김·정지 중에도. 대표자는 쇼핑몰 문의 전부, 직원은 자기가 쓴 것만.
// 쿼리: cursor · status(OPEN 접수|ANSWERED 답변 완료|CLOSED 종료) · category. 틀린 값은 400.
// 응답 { items: [{ id, category, title, status, urgent, createdAt, lastMessageAt, lastReplyAt(마지막 플랫폼 답변, 없으면 null), handlerState(PREPARING 답변 준비 중|ASSIGNED 담당자 배정됨|null 종료, 담당자 이름 없음), authorName, hasNewReply }],
//   counts: { all, open, answered, closed }(조건과 무관한 전체 상태별 건수), newReplyCount(새 답변이 달린 문의 수), avgFirstReplyMinutes(최근 30일 첫 답변까지 평균 분, 없으면 null), nextCursor }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const sp = new URL(req.url).searchParams;
    const r = await listMyInquiries(prisma, ctx, { cursor: sp.get("cursor"), status: sp.get("status"), category: sp.get("category") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(NextResponse.json({ items: r.items, counts: r.counts, newReplyCount: r.newReplyCount, avgFirstReplyMinutes: r.avgFirstReplyMinutes, nextCursor: r.nextCursor }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 문의 보내기(SA-114). 본문 { category: BROADCAST|PAYMENT_LINK|ORDER_REFUND|REWARD|SUBSCRIPTION_FEE|SHOP|ACCOUNT|OTHER, urgent?: boolean(긴급 표시), includeDiagnostics?: boolean(기본 true, false면 진단 정보를 붙이지 않음), title(80자까지), body, imageIds?: 최대 5, noticeId?, relatedOrderId?, relatedBroadcastId? }(관련 주문·방송은 이 쇼핑몰 것만, 아니면 400 invalid_related).
// 201 { inquiry } · 400 invalid_* · 429 too_many_inquiries(쇼핑몰당 24시간 20건)
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const r = await createInquiry(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  return noStore(NextResponse.json({ inquiry: r.inquiry }, { status: 201 }));
});
