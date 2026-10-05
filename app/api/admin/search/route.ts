import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { adminSearch, parseQuery } from "../../../../lib/server/search/service";

// 마스터 관리자 전역 검색. 마스터 관리자 전 역할이 본다(조회만). ?q=(최대 50자, 비면 빈 결과)
// → { sellers, orders, payments, inquiries, jobs: [{ id, title, sub, href }] } 종류별 최대 5건. 너무 긴 q는 400 bad_request.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = parseQuery(new URL(req.url).searchParams.get("q"));
    if (!p.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    return noStore(NextResponse.json(await adminSearch(prisma, admin, p.q)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
