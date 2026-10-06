import { NextResponse } from "next/server";
import { markAlertRead } from "../../../../../../lib/server/admin-alerts/service";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, sessionToken } from "../../../../../../lib/server/http/route";

// 알림 하나 읽음(관리자마다). 전 역할. 200 { ok: true } · 404(없거나 내 역할이 볼 수 없는 알림)
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ alertId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
  const r = await markAlertRead(prisma, admin, (await params).alertId);
  if (!r) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json({ ok: true }));
});
