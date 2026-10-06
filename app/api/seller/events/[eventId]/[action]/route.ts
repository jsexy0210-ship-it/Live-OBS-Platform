import { NextResponse } from "next/server";
import { AuthError } from "../../../../../../lib/server/authz/errors";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { cancelAudienceEvent, createNextAudienceRound, drawAudienceEvent, freezeAudienceEvent, publishAudienceResult } from "../../../../../../lib/server/events/service";
import { eventMutation } from "../../../../../../lib/server/events/errors";
import { EventError } from "../../../../../../lib/server/events/errors";
import { readEventJson } from "../../../../../../lib/server/events/http";
import { noStore, sessionToken } from "../../../../../../lib/server/http/route";

// 재시도는 저장된 같은 회차/결과를 반환한다. 요청에서 당첨자·보상을 받지 않는다.
export const POST = eventMutation(async (req: Request, { params }: { params: Promise<{ eventId: string; action: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const { eventId, action } = await params;
  const body = req.body ? await readEventJson(req) : {};
  let value: unknown;
  if (action === "next-round") value = await createNextAudienceRound(prisma, ctx, eventId, body);
  else if (action === "reveal" || action === "redisplay") {
    if (action === "redisplay" && "participantId" in body) throw new EventError(400, "invalid_request");
    value = await publishAudienceResult(prisma, ctx, eventId, body);
  } else if (action === "execute") {
    if (Object.keys(body).some(key => key !== "roundId") || typeof body.roundId !== "string") throw new EventError(400, "invalid_request");
    value = await drawAudienceEvent(prisma, ctx, eventId, body.roundId);
  } else {
    const handler = action === "freeze" ? freezeAudienceEvent : action === "draw" ? drawAudienceEvent : action === "cancel" ? cancelAudienceEvent : null;
    if (!handler) throw new AuthError(404, "not_found");
    if (Object.keys(body).length) throw new EventError(400, "invalid_request");
    value = await handler(prisma, ctx, eventId);
  }
  return noStore(NextResponse.json({ value, rewardsEnabled: false }));
});
