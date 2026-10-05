import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, remindSupplement } from "../../../../../../lib/server/sellers/applications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 재촉 메일(MA-013, seller.moderate): 보완 요청 중인 신청자에게 하루 한 번, 최대 3번. 실제로 보낸 때만 횟수를 센다.
// 200 { ok, sentAt, reminderCount } · 404 not_found · 409 not_pending·not_requested·remind_too_soon(+canRemindAt) · 429 mail_limit · 502 mail_failed · 503 mail_unavailable(메일 서비스 미연결)
const STATUS = { not_found: 404, not_pending: 409, not_requested: 409, remind_too_soon: 409, remind_limit: 409, mail_limit: 429, mail_failed: 502, mail_unavailable: 503 } as const;
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found", message: APPLICATION_MESSAGES.not_found }, { status: 404 });
  const r = await remindSupplement(prisma, admin, sellerId, { meta: requestMeta(req) });
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason], ...("canRemindAt" in r ? { canRemindAt: r.canRemindAt } : {}) }, { status: STATUS[r.reason] });
  return NextResponse.json({ ok: true, sentAt: r.sentAt, reminderCount: r.reminderCount });
});
