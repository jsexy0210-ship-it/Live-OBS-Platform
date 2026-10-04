import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { endBroadcast } from "../../../../../lib/server/queue/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 방송 종료. 선택 본문 { broadcastSessionId }. BROADCAST_RUN 권한.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  // 선택 본문 { broadcastSessionId }: 화면이 확인한 방송과 지금 LIVE 방송이 다르면 409 not_live(다른 방송을 끝내지 않음)
  const body = await readJson<{ broadcastSessionId: unknown }>(req);
  if (body.broadcastSessionId !== undefined && (typeof body.broadcastSessionId !== "string" || !UUID.test(body.broadcastSessionId))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const result = await endBroadcast(prisma, ctx, { broadcastSessionId: body.broadcastSessionId });
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: queueRejectionStatus(result.reason) });
  return NextResponse.json({ ...result.value, version: result.version });
});
