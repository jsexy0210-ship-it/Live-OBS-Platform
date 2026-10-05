import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { adminPgStatus } from "../../../../lib/server/payments/adminStatus";

// 마스터 관리자 PG 연결 상태(MA-031, platform.read, 조회만). ?q(쇼핑몰 이름·주소)·cursor·limit(기본 50, 최대 200).
// { gateway: { provider, configured, mode, lastSuccessAt, lastFailureAt, lastFailureCode, lastFailureMessage },
//   sellers: [{ seller, lastSuccessAt, lastFailureAt, lastFailureCode, lastFailureMessage, failures24h, cancelsPending, cancelsFailed }], nextCursor }
// 키 값·비밀정보는 내려주지 않는다(설정 여부만). 잘못된 값이면 400 bad_request.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await adminPgStatus(prisma, admin, { q: p.get("q"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const { ok: _ok, ...body } = r;
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
