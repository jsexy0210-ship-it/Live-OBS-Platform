import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, resolveSupplement } from "../../../../../../../lib/server/sellers/applications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 보완 확인(MA-013·014, seller.moderate): 신청자가 보완을 마친 것을 확인해 보완 요청 상태를 푼다(다시 확인 필요·이상 없음으로 돌아간다).
// 200 { ok } · 404 not_found · 409 not_requested
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found", message: APPLICATION_MESSAGES.not_found }, { status: 404 });
  const r = await resolveSupplement(prisma, admin, sellerId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason] }, { status: r.reason === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true });
});
