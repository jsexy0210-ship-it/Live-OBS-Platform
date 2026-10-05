import { NextResponse } from "next/server";
import { remindSupplement } from "../../../../../../../lib/server/admin/signupApplications";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";

// 재촉 메일(MA-013). 보완 요청 중인 신청만. 마지막 요청·재촉에서 24시간 뒤부터, 최대 3번(409 too_soon·reminder_limit).
// 메일 공급자가 없어 지금은 기록만 남긴다 → { ok, remindedAt, reminderCount, delivery: "RECORDED" }
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const r = await remindSupplement(prisma, admin, (await params).sellerId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, ...("nextReminderAt" in r ? { nextReminderAt: r.nextReminderAt } : {}) }, { status: r.reason === "not_found" ? 404 : 409 });
  return NextResponse.json(r);
});
