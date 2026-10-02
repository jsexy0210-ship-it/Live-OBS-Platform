import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { getQueueSnapshot } from "../../../../lib/server/queue/read";

export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    return NextResponse.json(await getQueueSnapshot(prisma, ctx));
  } catch (e) {
    return errorResponse(e);
  }
}
