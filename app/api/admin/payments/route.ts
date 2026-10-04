import { NextResponse } from "next/server";
import { listAdminPayments } from "../../../../lib/server/admin/billing";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 청구·결제 내역(MA-024). status(PENDING·PAID·FAILED)·kind(PERIOD·PRORATION)·sellerId·from·to(KST 날짜, 청구 시각)·cursor·limit.
// { payments: [{ id, seller, amount, status, kind, periodStart, periodEnd, scheduled, launchDiscount, failureReason, paidAt, createdAt, targetPlanCode }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listAdminPayments(prisma, admin, {
      status: p.get("status"),
      kind: p.get("kind"),
      sellerId: p.get("sellerId"),
      from: p.get("from"),
      to: p.get("to"),
      cursor: p.get("cursor"),
      limit: p.get("limit"),
    });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ payments: r.payments, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
