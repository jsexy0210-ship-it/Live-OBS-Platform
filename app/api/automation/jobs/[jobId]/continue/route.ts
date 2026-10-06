import { NextResponse } from "next/server";
import { continueJob } from "../../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { isJobId } from "../../../../../../lib/server/automation/ids";

// 이어 하기(SA-152). 멈춘 작업을 풀어 바로 대기열로 돌린다(멈춘 단계부터 다시 시작). 멈춰 있지 않으면 409 invalid_state.
// 고객 확인을 마친 뒤 이어 가는 resume과 다르다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "OVERLAY" });
  if (!isJobId(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await continueJob(prisma, ctx, jobId);
  return noStore(r.ok ? NextResponse.json(r.job) : NextResponse.json({ error: r.reason }, { status: 409 }));
});
