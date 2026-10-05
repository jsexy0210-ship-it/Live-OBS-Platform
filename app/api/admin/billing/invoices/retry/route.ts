import { NextResponse } from "next/server";
import { retryFailedInvoices } from "../../../../../../lib/server/admin/billingInvoices";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { billingProvider } from "../../../../../../lib/server/billing/registry";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 실패 건 재시도(MA-024, 최고관리자·운영). 본문 { paymentIds: string[1~50] }(목록 행 paymentId, canRetry인 건).
// 결과 { results[{ paymentId, ok, result?: PAID|FAILED|PENDING, reason? }], succeeded, failed }. reason: not_found·not_failed·not_latest·not_retryable·too_soon·not_charged·charge_failed·charge_pending·failed.
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "billing.manage");
  const body = await readJson<{ paymentIds: unknown }>(req);
  const r = await retryFailedInvoices(prisma, billingProvider(), admin, body?.paymentIds, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json(r);
});
