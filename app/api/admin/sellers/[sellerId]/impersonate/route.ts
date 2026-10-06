import { NextResponse } from "next/server";
import { startImpersonation } from "../../../../../../lib/server/auth/impersonation";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken, setImpersonationCookie } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 화면 대리 조회 시작(MA-016). 최고관리자·운영·CS(seller.impersonate), 조회 전용 역할은 403.
// 본문 { reason(1~200자 필수), category?: INQUIRY|INCIDENT|FINANCE_CHECK|AUDIT, relatedKind?: INQUIRY|NOTIFICATION|REPORT, relatedId?: uuid(같은 쇼핑몰 건, 분류가 INQUIRY·INCIDENT이면 필수),
//   scopes?: [BROADCAST|OVERLAY|ORDERS|MEMBERS|SETTINGS_PG](1개 이상), durationMinutes?: 15|30|60(60은 최고관리자만) }.
// 분류·범위·시간을 보내지 않으면 이전 방식(범위 주문·회원, 기본 시간)으로 연다. 보내면 모두 검사한다.
// 성공 { ok: true, seller: { id, shopName, slug }, expiresAt, scopes } + 쿠키 lo_imp(경로 /api/seller, 파트너스 API에서만 읽기 전용으로 통한다). 열 때 로그 추적에 분류·범위·시간을 남긴다.
// 사유 없음·길이 초과 400 reason_required, 입력 오류 400(category_invalid·related_required·related_invalid·scopes_required·duration_invalid), 60분을 최고관리자가 아닌 쪽이 고르면 403 duration_not_allowed,
// 운영·정지 상태가 아닌 쇼핑몰 409 seller_not_viewable, 없으면 404.
const BAD_REQUEST = new Set(["reason_required", "category_invalid", "related_required", "related_invalid", "scopes_required", "duration_invalid"]);
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ sellerId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.impersonate");
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: unknown; category?: unknown; relatedKind?: unknown; relatedId?: unknown; scopes?: unknown; durationMinutes?: unknown }>(req);
  const r = await startImpersonation(prisma, admin, sellerId, body.reason, requestMeta(req), new Date(), {
    category: body.category,
    relatedKind: body.relatedKind,
    relatedId: body.relatedId,
    scopes: body.scopes,
    durationMinutes: body.durationMinutes,
  });
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: BAD_REQUEST.has(r.reason) ? 400 : r.reason === "duration_not_allowed" ? 403 : 409 });
  const res = NextResponse.json({ ok: true, seller: r.seller, expiresAt: r.expiresAt, scopes: r.scopes });
  setImpersonationCookie(res, r.token, r.expiresAt);
  return res;
});
