import { NextResponse } from "next/server";
import { startImpersonation } from "../../../../../../lib/server/auth/impersonation";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken, setImpersonationCookie } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 화면 대리 조회 시작(MA-016). 최고관리자·운영·CS(seller.impersonate), 조회 전용 역할은 403. 본문 { reason }(1~200자 필수).
// 성공 { ok: true, seller: { id, shopName, slug }, expiresAt }(30분) + 쿠키 lo_imp(경로 /api/seller, 파트너스 API에서만 읽기 전용으로 통한다). 열 때 로그 추적에 남긴다.
// 사유 없음·길이 초과 400 reason_required, 운영·정지 상태가 아닌 쇼핑몰 409 seller_not_viewable, 없으면 404.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.impersonate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: unknown }>(req);
  const r = await startImpersonation(prisma, admin, sellerId, body.reason, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "reason_required" ? 400 : 409 });
  const res = NextResponse.json({ ok: true, seller: r.seller, expiresAt: r.expiresAt });
  setImpersonationCookie(res, r.token, r.expiresAt);
  return res;
});
