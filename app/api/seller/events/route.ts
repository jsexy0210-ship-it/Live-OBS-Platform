import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { readEventJson } from "../../../../lib/server/events/http";
import { eventErrorResponse, eventMutation } from "../../../../lib/server/events/errors";
import { createAudienceEvent, EVENT_NOTICE, readAudienceEvents } from "../../../../lib/server/events/service";
import { noStore, sessionToken } from "../../../../lib/server/http/route";

// OVERLAY/BROADCAST_RUN. UI는 정본 확정 뒤 연결한다. POST는 방송 고지 확인을 요구하며 참가자 동의를 대신하지 않는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json({ events: await readAudienceEvents(prisma, ctx, new URL(req.url).searchParams.get("broadcastSessionId")), notice: EVENT_NOTICE, rewardsEnabled: false }));
  } catch (e) { return eventErrorResponse(e); }
}
export const POST = eventMutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const event = await createAudienceEvent(prisma, ctx, await readEventJson(req));
  return noStore(NextResponse.json({ event, notice: EVENT_NOTICE, rewardsEnabled: false }, { status: 201 }));
});
