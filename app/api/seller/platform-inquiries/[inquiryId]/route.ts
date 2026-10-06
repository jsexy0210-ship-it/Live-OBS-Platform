import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getMyInquiry } from "../../../../../lib/server/platform-inquiries/service";

// 문의 상세(SA-115). 연 시각을 읽음으로 남긴다. 볼 수 없는 문의는 404.
// → { inquiry: { id, category, title, status, createdAt, lastMessageAt, closedAt, closedBy(PARTNER|PLATFORM|null), authorName, notice: { id, title } | null,
//   related: { order: { id, orderNoLabel, nickname, createdAt } | null, broadcast: { id, title, startedAt } | null },
//   helpful(true 도움됨|false 아니요|null 아직), helpfulAt, canClose(종료할 수 있음), canRate(평가할 수 있음: 플랫폼 답변이 있고 아직 평가 전),
//   history: [{ type: RECEIVED|ANSWERED|FOLLOWUP|CLOSED, at, actor: PARTNER|PLATFORM }](처리 이력, 최신순, 담당 배정·마스터 관리자 이름은 없음),
//   messages: [{ id, author: PARTNER|PLATFORM, authorName(플랫폼 답변은 null), body, createdAt, images: [{ id, width, height, url }] }] } }
export async function GET(req: Request, { params }: { params: Promise<{ inquiryId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const inquiry = await getMyInquiry(prisma, ctx, (await params).inquiryId);
    if (!inquiry) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json({ inquiry }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
