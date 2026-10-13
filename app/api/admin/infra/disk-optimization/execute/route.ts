import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { executeApprovedDiskOptimization } from "../../../../../../lib/server/ops/diskOptimizationConnected";

export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
  const r = await executeApprovedDiskOptimization(prisma, admin, await readJson(req), requestMeta(req));
  return noStore(NextResponse.json({ ...r, error: r.reason }, { status: r.status }));
});
