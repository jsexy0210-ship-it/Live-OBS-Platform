import { NextResponse } from "next/server";
import { listLivePayoutSellers } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 적립금 실지급 켜진 파트너스(MA-043, 조회만, 마스터 관리자 전 역할).
// { items: [{ sellerId, shopName, slug, status, enabledAt, earnTiming, outstanding: { amount, members } }] }
// 월 거래액·잔액 비율은 기존 관리자 상세의 paidAt 월 순액 기준. 수동 양수 ADJUST는 실성공 processedAt 최근 30×24시간.
// 오늘 실패는 현재 원장 관측값이며 모의/실제 불확실·날짜 누락이면 failed=null. 반복 시도 이력·수동 집중 기준은 미지원이다.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await listLivePayoutSellers(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
