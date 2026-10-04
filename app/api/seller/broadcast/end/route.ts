import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, queueRejectionStatus, sessionToken } from "../../../../../lib/server/http/route";
import { endBroadcast } from "../../../../../lib/server/queue/service";

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const result = await endBroadcast(prisma, ctx);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ ...result.value, version: result.version });
});
