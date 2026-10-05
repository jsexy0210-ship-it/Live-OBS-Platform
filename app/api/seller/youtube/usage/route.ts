import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { chatUsage } from "../../../../../lib/server/youtube/settings";

// 이번 달 채팅 수집 현황(SA-057): { month, messages, storedMessages, units: { month, monthLimit, today, todayLimit }, collecting, stoppedReason }.
// 대표자·BROADCAST_RUN, 플랜 기능 OVERLAY. 규칙은 lib/server/youtube/settings.ts.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return noStore(NextResponse.json(await chatUsage(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}
