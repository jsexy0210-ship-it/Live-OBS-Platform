import { NextResponse } from "next/server";
import { pauseJob } from "../../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { isJobId } from "../../../../../../lib/server/automation/ids";

// 잠시 멈추기(SA-152). 대기열·실행 중·검증 중인 작업을 멈춘 단계 그대로 두고 작업자가 가져가지 못하게 한다(응답은 작업 조회와 같고 paused=true).
// 이미 멈췄거나 고객 행동 대기·끝난 작업은 409 invalid_state. 시작·전체·실행 시간 마감은 멈춰도 그대로 흐른다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "OVERLAY" });
  if (!isJobId(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await pauseJob(prisma, ctx, jobId);
  return noStore(r.ok ? NextResponse.json(r.job) : NextResponse.json({ error: r.reason }, { status: 409 }));
});
