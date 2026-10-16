import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { diskOptimizationStatus } from "../../../../../lib/server/ops/diskOptimization";

export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
    return noStore(NextResponse.json(await diskOptimizationStatus(prisma, admin)));
  } catch (e) { return noStore(errorResponse(e)); }
}
