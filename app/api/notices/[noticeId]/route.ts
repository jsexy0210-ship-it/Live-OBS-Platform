import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { errorResponse } from "../../../../lib/server/http/route";
import { getNotice } from "../../../../lib/server/platform-notices/service";

export const dynamic = "force-dynamic";

// 공개 플랫폼 공지 상세(PF-006). 목록과 같은 기준. 임시 저장·삭제·파트너스 전용 공지는 404.
export async function GET(_req: Request, { params }: { params: Promise<{ noticeId: string }> }) {
  try {
    return NextResponse.json({ notice: await getNotice(prisma, "public", (await params).noticeId) });
  } catch (e) {
    return errorResponse(e);
  }
}
