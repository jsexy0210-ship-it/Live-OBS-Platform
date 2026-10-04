import { NextResponse } from "next/server";
import { setSellerSuspended } from "../../../../../../lib/server/admin/sellers";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 이용 정지(MA-015). 본문 { reason }(1~200자 필수). 운영 중인 파트너스만, 정지되면 파트너스 로그인·세션이 바로 막힌다.
// 성공 { ok: true, status }. 사유 없음 400 reason_required, 지금 상태가 아니면 409, 없으면 404.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.moderate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: unknown }>(req);
  const r = await setSellerSuspended(prisma, admin, sellerId, { suspend: true, reason: body.reason }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : r.reason === "reason_required" ? 400 : 409 });
  return NextResponse.json(r);
});
