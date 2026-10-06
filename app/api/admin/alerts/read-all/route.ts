import { NextResponse } from "next/server";
import { markAllAlertsRead } from "../../../../../lib/server/admin-alerts/service";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 내가 볼 수 있는 안 읽은 알림 모두 읽음. 전 역할. → { marked }
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
  return noStore(NextResponse.json({ marked: (await markAllAlertsRead(prisma, admin)).marked }));
});
