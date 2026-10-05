import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getNotice } from "../../../../../lib/server/platform-notices/service";

// 플랫폼 공지 상세(SA-112). 목록과 같은 기준. 임시 저장·삭제·공개 전용 공지는 404.
export async function GET(req: Request, { params }: { params: Promise<{ noticeId: string }> }) {
  try {
    await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return NextResponse.json({ notice: await getNotice(prisma, "partners", (await params).noticeId) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
