import { NextResponse } from "next/server";
import { listAdminSellers } from "../../../../lib/server/admin/sellerList";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 파트너스 목록(MA-011, 모든 마스터 역할). 잘못된 값은 400 bad_request.
// 검색: q(50자) + field(all·shop·rep·email·slug·biz, 기본 all). 필터: status(판매자 상태)·state(NORMAL·TRIAL·OVERDUE·LOCKED·SUSPENDED·CLOSED 표시 상태)·plan·pg(OK·ERROR·NONE)·live=1·payout=1·note=1·
//   joinedFrom·joinedTo(YYYY-MM-DD, 한국 날짜)·active(7d·30d·inactive30). 정렬 sort: joined(가입일순, 기본)·activity(최근 활동순)·orders(이번 달 주문 많은순)·overdue(연체 먼저).
// 쪽: limit(기본 50·최대 200)·cursor(응답 nextCursor). summary=1이면 상단 요약 건수를 함께 준다.
// { sellers: [{ id, slug, shopName, status, displayStatus, seq, representativeName, plan, subscription, trialEndsAt, approvedAt, createdAt,
//     pg: { status: OK|ERROR|NONE, lastSuccessAt, lastFailureAt }, live, ordersThisMonth(이번 달 결제된 주문), memberCount(탈퇴 제외), lastActivityAt, payoutEnabled(적립금 실제 지급), noteCount }],
//   total(조건에 맞는 전체 수), nextCursor, summary?: { total, normal, trial, overdue, locked, suspended, closed, pgError, pgNone, payoutEnabled, live, pendingApplications } }
// 엑셀 내려받기는 GET /api/admin/sellers/export(같은 조건). 대표자 연락처는 어느 응답에도 없다.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const g = (k: string) => p.get(k);
    const r = await listAdminSellers(prisma, admin, {
      q: g("q"), field: g("field"), status: g("status"), state: g("state"), plan: g("plan"), pg: g("pg"), live: g("live"), payout: g("payout"), note: g("note"),
      joinedFrom: g("joinedFrom"), joinedTo: g("joinedTo"), active: g("active"), sort: g("sort"), cursor: g("cursor"), limit: g("limit"), summary: g("summary"),
    });
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
