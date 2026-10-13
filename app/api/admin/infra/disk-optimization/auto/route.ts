import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { updateDiskOptimizationAuto } from "../../../../../../lib/server/ops/diskOptimization";

export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
  const r = await updateDiskOptimizationAuto(prisma, admin, await readJson(req), requestMeta(req));
  return noStore(NextResponse.json(r.ok ? r : { ...r, error: r.reason }, { status: r.ok ? 200 : r.status }));
});
