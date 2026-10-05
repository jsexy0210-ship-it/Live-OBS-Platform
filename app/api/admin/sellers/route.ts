import { NextResponse } from "next/server";
import { listAdminSellers } from "../../../../lib/server/admin/sellers";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 파트너스 목록(MA-011). q(쇼핑몰 이름·주소)·status·plan·cursor·limit(기본 50·최대 200). 잘못된 값은 400.
// { sellers: [{ id, slug, shopName, status, plan, subscription, trialEndsAt, approvedAt, createdAt }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listAdminSellers(prisma, admin, { q: p.get("q"), status: p.get("status"), plan: p.get("plan"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ sellers: r.sellers, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
