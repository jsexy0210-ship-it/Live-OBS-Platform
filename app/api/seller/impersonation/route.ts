import { NextResponse } from "next/server";
import { IMPERSONATION_COOKIE, resolveImpersonation } from "../../../../lib/server/auth/impersonation";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, readCookie, sessionToken } from "../../../../lib/server/http/route";

// 마스터 대리 조회 중인지(MA-016 읽기 전용 배너용). 파트너스 로그인이든 대리 조회든 같은 가드를 거친다.
// 대리 조회(쿠키 lo_imp 유효)면 { active: true, readOnly: true, seller, reason, adminName, startedAt, expiresAt }, 일반 파트너스 로그인이면 { active: false }, 아니면 401.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const imp = ctx.readOnly ? await resolveImpersonation(prisma, readCookie(req, IMPERSONATION_COOKIE)) : null;
    if (!imp) return noStore(NextResponse.json({ active: false }));
    return noStore(
      NextResponse.json({
        active: true,
        readOnly: true,
        seller: { id: imp.seller.id, shopName: imp.seller.shopName, slug: imp.seller.slug },
        reason: imp.reason,
        adminName: imp.adminName,
        startedAt: imp.startedAt,
        expiresAt: imp.expiresAt,
      }),
    );
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
