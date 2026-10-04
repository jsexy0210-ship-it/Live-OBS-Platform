import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { listSellerMembers } from "../../../../lib/server/buyers/sellerMembers";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 파트너스 회원 목록. 쿼리: q(닉네임, 이름·휴대폰 끝 4자리는 개인정보 권한), gradeId, status(ACTIVE·DORMANT), cursor, limit(기본 50, 최대 200).
// MEMBER_POINTS 권한. 탈퇴 회원은 빠진다. 잠금 중에도 이미 받은 주문의 고객 응대를 위해 볼 수 있다(주문 후속 처리와 같은 기준).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await listSellerMembers(prisma, ctx, {
      q: p.get("q"),
      gradeId: p.get("gradeId"),
      status: p.get("status"),
      cursor: p.get("cursor"),
      limit: p.get("limit"),
    });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ members: r.members, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
