import { NextResponse } from "next/server";
import { getJob } from "../../../../../lib/server/automation/jobs";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { isJobId } from "../../../../../lib/server/automation/ids";


// 작업 하나. 다른 판매자 작업은 404(있는지도 알리지 않음).
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
    if (!isJobId(jobId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return noStore(NextResponse.json(await getJob(prisma, ctx, jobId)));
  } catch (e) {
    return errorResponse(e);
  }
}
