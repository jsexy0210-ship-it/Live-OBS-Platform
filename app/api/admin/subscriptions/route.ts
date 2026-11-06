import { NextResponse } from "next/server";
import { listAdminSubscriptions } from "../../../../lib/server/admin/billing";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 구독 현황(MA-023). access(trial·paid·charging·grace·expired, locked = 연체 유예가 끝나 이용이 막힌 건(이용 상태는 expired), cancelling = 해지 예정(기간 끝 해지 예약). 쉼표로 여러 개를 주면 하나라도 맞는 건)·plan·q(쇼핑몰 이름·주소)·nextFrom/nextTo(다음 결제일 KST YYYY-MM-DD, 끝 날짜 포함)·cursor·limit(기본 10·최대 200). 잘못된 값 400.
// monthRevenue { month("YYYY-MM" KST), start, end, paidAmount, paidCount } = 이번 달 결제 확정(PAID, paidAt) 구독 청구 합계(MA-023 「월 구독 매출」, 환불은 빼지 않음).
// { counts: { trial, paid, charging, grace, expired, locked, cancelling }, subscriptions: [{ seller, access, plan { code, name, listPrice, salePrice }, trialEndsAt, lastPayment { amount, status, paidAt, createdAt } | null, subscription }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listAdminSubscriptions(prisma, admin, { access: p.get("access"), nextFrom: p.get("nextFrom"), nextTo: p.get("nextTo"), plan: p.get("plan"), q: p.get("q"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ counts: r.counts, monthRevenue: r.monthRevenue, subscriptions: r.subscriptions, nextCursor: r.nextCursor });
  } catch (e) {
    return errorResponse(e);
  }
}
