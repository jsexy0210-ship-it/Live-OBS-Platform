import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, sessionToken } from "../../../../../../lib/server/http/route";
import { markNoticeRead } from "../../../../../../lib/server/platform-notices/service";

// 공지 읽음 표시(SA-112). 상세를 열었을 때 화면이 부른다. 계정(직원 포함)별로 한 번만 남고 여러 번 불러도 같다.
// 구독이 잠기거나 이용 정지 중에도 된다. 마스터 대리 조회(읽기 전용)는 403, 없는·비공개·공개 전용 공지는 404. 응답 { read: true, unreadCount }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ noticeId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  return NextResponse.json(await markNoticeRead(prisma, ctx, (await params).noticeId), { headers: { "cache-control": "no-store" } });
});
