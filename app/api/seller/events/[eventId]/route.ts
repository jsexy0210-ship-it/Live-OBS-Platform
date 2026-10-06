import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { readAudienceEvent } from "../../../../../lib/server/events/service";
import { eventErrorResponse } from "../../../../../lib/server/events/errors";
import { noStore, sessionToken } from "../../../../../lib/server/http/route";

export async function GET(req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await readAudienceEvent(prisma, ctx, (await params).eventId, new URL(req.url).searchParams.get("cursor"))));
  } catch (e) { return eventErrorResponse(e); }
}
