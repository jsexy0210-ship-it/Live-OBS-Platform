import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../../lib/server/db";
import { mutation, noStore, requestMeta, sessionToken } from "../../../../../../../../lib/server/http/route";
import { cancelWindow } from "../../../../../../../../lib/server/maintenance/windows";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 예약 취소(최고관리자만, 시작 전 예약만). 시작이 지난 점검은 409 not_open — 점검 종료로 닫는다.
// 200 { window } · 404 없는 점검 · 409 not_open
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ windowId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
  const { windowId } = await params;
  if (!UUID.test(windowId)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const r = await cancelWindow(prisma, admin, windowId, requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ window: r.window }));
  return noStore(NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : 409 }));
});
