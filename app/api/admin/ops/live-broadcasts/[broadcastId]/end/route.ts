import { NextResponse } from "next/server";
import { forceEndBroadcast } from "../../../../../../../lib/server/admin/broadcastEnd";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../../lib/server/http/route";

// 방송 강제 종료(MA-041). 본문 { reason }(1~200자 필수). 운영·최고관리자(seller.moderate)만. 성공 { ok: true, broadcastId, carriedOver }.
// 사유 없음 400 reason_required, 없는 방송 404, 이미 끝난 방송 409 not_live. 개봉 중 항목은 그대로 두고 남은 대기는 다음 방송으로 이월한다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ broadcastId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const body = await readJson<{ reason: unknown }>(req);
  const r = await forceEndBroadcast(prisma, admin, (await params).broadcastId, body.reason);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : r.reason === "reason_required" ? 400 : 409 });
  return NextResponse.json(r);
});
