import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { reorderWaiting } from "../../../../../lib/server/queue/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 순서 변경. expectedVersion은 화면이 받은 /api/seller/queue 응답의 version(필수)이다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const body = await readJson<{ broadcastSessionId: string | null; orderedIds: string[]; expectedVersion: number }>(req);
  const ids = body.orderedIds;
  const scope = body.broadcastSessionId ?? null;
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    !ids.every((v) => typeof v === "string" && UUID.test(v)) ||
    (scope !== null && (typeof scope !== "string" || !UUID.test(scope))) ||
    !Number.isInteger(body.expectedVersion)
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await reorderWaiting(prisma, ctx, { broadcastSessionId: scope, orderedIds: ids, expectedLiveVersion: body.expectedVersion as number });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ count: result.value, version: result.version });
});
