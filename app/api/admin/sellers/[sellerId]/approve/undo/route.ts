import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";
import { APPLICATION_MESSAGES, undoApproval } from "../../../../../../../lib/server/sellers/applications";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 승인 되돌리기(MA-013, seller.moderate): 방금(10초 안, approve 응답의 undoableUntil까지) 이 관리자가 한 승인을 취소해 승인 대기로 돌리고 로그인 세션을 끊는다.
// 200 { ok } · 404 not_found · 409 undo_expired(10초 지남)·not_undoable(자동 승인·다른 관리자의 승인·승인 상태 아님)
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found", message: APPLICATION_MESSAGES.not_found }, { status: 404 });
  const r = await undoApproval(prisma, admin, sellerId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: APPLICATION_MESSAGES[r.reason] }, { status: r.reason === "not_found" ? 404 : 409 });
  return NextResponse.json({ ok: true });
});
