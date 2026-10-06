import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { readPublicEventParticipation } from "../../../../../lib/server/events/entries";
import { eventErrorResponse } from "../../../../../lib/server/events/errors";
import { noStore } from "../../../../../lib/server/http/route";
export async function GET(_req: Request, { params }: { params: Promise<{ eventId: string }> }) {
  try { return noStore(NextResponse.json(await readPublicEventParticipation(prisma, (await params).eventId))); }
  catch(error) { return eventErrorResponse(error); }
}
