import { NextResponse } from "next/server";
import { exportAdminSellers } from "../../../../../lib/server/admin/sellerList";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

// 파트너스 목록 엑셀(CSV) 내려받기(MA-011, 모든 마스터 역할). 목록과 같은 검색·필터·정렬 조건(q·field·status·state·plan·pg·live·payout·note·joinedFrom·joinedTo·active·sort), 최대 5,000건.
// UTF-8(BOM) CSV. 열: 번호·쇼핑몰 이름·쇼핑몰 주소·상태·구독·결제 연결·방송 중·이번 달 주문·회원 수·가입일·최근 활동. 대표자 연락처는 넣지 않는다. 내려받은 사실은 로그 추적(admin.sellers.export)에 남는다.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const g = (k: string) => p.get(k);
    const r = await exportAdminSellers(
      prisma,
      admin,
      { q: g("q"), field: g("field"), status: g("status"), state: g("state"), plan: g("plan"), pg: g("pg"), live: g("live"), payout: g("payout"), note: g("note"), joinedFrom: g("joinedFrom"), joinedTo: g("joinedTo"), active: g("active"), sort: g("sort") },
      requestMeta(req),
    );
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="partners-${day}.csv"` } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
