import { NextResponse } from "next/server";
import { AuthError } from "../../../../../../lib/server/authz/errors";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { cancelAudienceEvent, drawAudienceEvent, freezeAudienceEvent } from "../../../../../../lib/server/events/service";
import { eventMutation } from "../../../../../../lib/server/events/errors";
import { EventError } from "../../../../../../lib/server/events/errors";
import { readEventJson } from "../../../../../../lib/server/events/http";
import { noStore, sessionToken } from "../../../../../../lib/server/http/route";

// 재시도는 저장된 같은 회차/결과를 반환한다. 요청에서 당첨자·보상을 받지 않는다.
export const POST = eventMutation(async (req: Request, { params }: { params: Promise<{ eventId: string; action: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const { eventId, action } = await params;
  const handler = action === "freeze" ? freezeAudienceEvent : action === "draw" ? drawAudienceEvent : action === "cancel" ? cancelAudienceEvent : null;
  if (!handler) throw new AuthError(404, "not_found");
  if (req.body && Object.keys(await readEventJson(req)).length) throw new EventError(400, "invalid_request");
  return noStore(NextResponse.json({ value: await handler(prisma, ctx, eventId), rewardsEnabled: false }));
});
