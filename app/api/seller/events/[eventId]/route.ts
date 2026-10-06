import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { previewAudienceEvent, readAudienceEvent } from "../../../../../lib/server/events/service";
import { eventErrorResponse } from "../../../../../lib/server/events/errors";
import { noStore, sessionToken } from "../../../../../lib/server/http/route";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const query = new URL(req.url).searchParams, eventId = (await params).eventId;
    const value = query.get("preview") === "1" ? await previewAudienceEvent(prisma, ctx, eventId, query.get("roundId")) : await readAudienceEvent(prisma, ctx, eventId, query.get("cursor"), query.get("roundId"));
    return noStore(NextResponse.json(value));
  } catch (e) { return eventErrorResponse(e); }
}
