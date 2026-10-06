import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../../lib/server/http/route";
import { diskOptimizationJob } from "../../../../../../../lib/server/ops/diskOptimization";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
    const r = diskOptimizationJob(admin, (await params).id);
    return noStore(NextResponse.json({ ...r, error: r.reason }, { status: r.status }));
  } catch (e) { return noStore(errorResponse(e)); }
}
