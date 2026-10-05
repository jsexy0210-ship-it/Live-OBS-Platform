import { NextResponse } from "next/server";
import { adminJobDetail } from "../../../../../../lib/server/automation/admin";
import { isJobId } from "../../../../../../lib/server/automation/ids";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";

// 자동 연결 작업 상세(MA-111, 조회만). 상태 전이 기록·결제·비용. 비밀값·내부 기록 값은 내보내지 않는다.
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { jobId } = await params;
    const j = isJobId(jobId) ? await adminJobDetail(prisma, jobId) : null;
    return noStore(j ? NextResponse.json(j) : NextResponse.json({ error: "not_found" }, { status: 404 }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
