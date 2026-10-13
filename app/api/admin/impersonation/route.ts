import { NextResponse } from "next/server";
import { activeImpersonation, endImpersonation } from "../../../../lib/server/auth/impersonation";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { clearImpersonationCookie, errorResponse, mutation, noStore, requestMeta, sessionToken } from "../../../../lib/server/http/route";

// 내가 열어 둔 대리 조회(MA-016). GET → { active: null | { sellerId, shopName, slug, reason, category, relatedKind, relatedId, scopes, startedAt, expiresAt } }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.impersonate");
    return noStore(NextResponse.json({ active: await activeImpersonation(prisma, admin) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 대리 조회 끝내기. 열린 것을 모두 끝내고(로그 추적에 남김) lo_imp 쿠키를 Set-Cookie로 만료시킨다(Path=/api/seller). → { ok: true, ended }
export const DELETE = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "seller.impersonate");
  const r = await endImpersonation(prisma, admin, requestMeta(req));
  const res = NextResponse.json({ ok: true, ended: r.ended });
  // lo_imp는 경로가 /api/seller라 HttpOnly 쿠키를 화면 JS가 못 지운다. 이 응답이 같은 경로로 만료시킨다(브라우저는 응답 경로와 다른 Path의 쿠키도 지운다)
  clearImpersonationCookie(res);
  return res;
});
