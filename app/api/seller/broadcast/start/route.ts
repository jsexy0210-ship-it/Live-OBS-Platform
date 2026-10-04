import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { startBroadcast } from "../../../../../lib/server/queue/service";

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ title: string }>(req);
  const result = await startBroadcast(prisma, ctx, { title: typeof body.title === "string" ? body.title.slice(0, 100) : undefined });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ ...result.value, version: result.version });
});
