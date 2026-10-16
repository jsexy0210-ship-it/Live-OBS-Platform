import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { previewApprovedDiskOptimization } from "../../../../../../lib/server/ops/diskOptimizationConnected";

export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
  const r = await previewApprovedDiskOptimization(prisma, admin, await readJson(req));
  return noStore(NextResponse.json({ ...r, error: r.reason }, { status: r.status }));
});
