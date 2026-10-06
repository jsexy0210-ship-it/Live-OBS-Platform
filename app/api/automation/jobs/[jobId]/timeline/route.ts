import { NextResponse } from "next/server";
import { getJobTimeline } from "../../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { isJobId } from "../../../../../../lib/server/automation/ids";

// 작업 기록 시각표(SA-152). → { job(작업 조회와 같음), timeline: [{ at, kind, stepNumber, reason }] } 오래된 순, 최대 200건.
// kind: payment_confirmed · started · needs_customer · resumed · verifying · retry · paused · continued · succeeded · failed · canceled · cleanup_needed · other
// reason은 정해 둔 사유 코드만(비밀번호·인증번호·작업자 식별자·원문 오류는 내보내지 않는다). 다른 판매자 작업은 404.
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "OVERLAY" });
    if (!isJobId(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return noStore(NextResponse.json(await getJobTimeline(prisma, ctx, jobId)));
  } catch (e) {
    return errorResponse(e);
  }
}
