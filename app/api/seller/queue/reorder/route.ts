import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { reorderWaiting } from "../../../../../lib/server/queue/service";

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const body = await readJson<{ broadcastSessionId: string | null; orderedIds: string[] }>(req);
  const ids = body.orderedIds;
  if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((v) => typeof v === "string")) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const scope = typeof body.broadcastSessionId === "string" ? body.broadcastSessionId : null;
  const result = await reorderWaiting(prisma, ctx, { broadcastSessionId: scope, orderedIds: ids });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ count: result.value, version: result.version });
});
