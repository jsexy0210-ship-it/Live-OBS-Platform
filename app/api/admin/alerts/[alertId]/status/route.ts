import { NextResponse } from "next/server";
import { ADMIN_ALERT_MESSAGES, setAlertStatus } from "../../../../../../lib/server/admin-alerts/service";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 알림 상태 변경(MA-002 미처리·처리 중·해결됨). 최고관리자·운영·CS. 본문 { status: OPEN|IN_PROGRESS|RESOLVED }. 처리 중으로 바꾸면 담당이 없을 때 바꾼 사람이 담당이 된다.
// 200 { ok: true } · 400 invalid_status_change · 404
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ alertId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.assign");
  const r = await setAlertStatus(prisma, admin, (await params).alertId, await readJson(req), requestMeta(req));
  if (r.ok) return noStore(NextResponse.json({ ok: true }));
  if (r.reason === "not_found") return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json({ error: r.reason, message: ADMIN_ALERT_MESSAGES[r.reason] }, { status: 400 }));
});
