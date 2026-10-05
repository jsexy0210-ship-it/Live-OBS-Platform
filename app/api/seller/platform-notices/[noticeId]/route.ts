import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerNotice } from "../../../../../lib/server/platform-notices/service";

// 플랫폼 공지 상세(SA-112). 목록과 같은 기준. 임시 저장·삭제·공개 전용 공지는 404.
// 응답 { notice: { id, title, body, category, isPinned, publishedAt, channels, read, prev, next, related } }.
// prev·next는 게시일 최신순 목록에서 바로 위(더 최근)·바로 아래(더 오래된) 공지 { id, title, category, publishedAt }(고정 여부와 무관, 없으면 null), related는 같은 분류의 다른 공지 최근 3개.
// 열기만 해서는 읽음 처리하지 않는다. 화면이 POST .../read를 부른다.
export async function GET(req: Request, { params }: { params: Promise<{ noticeId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return NextResponse.json({ notice: await getSellerNotice(prisma, ctx, (await params).noticeId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
