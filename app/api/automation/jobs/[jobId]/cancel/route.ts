import { NextResponse } from "next/server";
import { cancelJob } from "../../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { isJobId } from "../../../../../../lib/server/automation/ids";


// 취소. 실행 중이면 작업자의 다음 쓰기부터 막힌다. 환불은 자동으로 하지 않는다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ jobId: string }> }) => {
  const { jobId } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
  if (!isJobId(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await cancelJob(prisma, ctx, jobId);
  return noStore(r.ok ? NextResponse.json(r.job) : NextResponse.json({ error: r.reason }, { status: 409 }));
});
