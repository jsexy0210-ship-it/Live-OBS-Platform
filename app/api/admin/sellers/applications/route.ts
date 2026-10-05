import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listApplications } from "../../../../../lib/server/sellers/applications";

// 마스터 관리자 가입 신청(MA-013, 모든 마스터 역할 조회). 잘못된 값은 400 bad_request.
// tab: all(전체, 기본)·clear(이상 없음)·review(확인 필요)·supplement(보완 요청)·over48h(48시간 초과)·today(오늘 접수)·history(자동 승인·승인·반려 이력, 최근 30일)
// sort: oldest(오래된 순, 기본)·newest. 검색: q(50자)+field(all·shop·applicant·biz). 필터: industry(업종)·receivedFrom/To(YYYY-MM-DD 한국 날짜). 쪽: limit(기본 20·최대 100)·cursor(응답 nextCursor).
// { chips: { all, clear, review, supplement, over48h, today }, kpi: { pending, needsReview, clear, supplement, over48h, receivedToday, autoApprovedToday, autoApprovedMonth, approvedToday,
//     rejectedToday, rejectedMonth, avgHandlingHours: { thisWeek, lastWeek } }, industries: [업종 목록(필터 선택지)], total, nextCursor,
//   applications: [{ id, slug, shopName, state(CLEAR·REVIEW·SUPPLEMENT), applicantName, applicantEmail, businessNumber, industry, receivedAt, elapsedHours, over48h,
//     reasons: [{ code, text }], supplement: { reason, requestedAt, dueAt, daysLeft, reminderCount, lastReminderAt, canRemindAt } | null }]  (tab=history이면 applications 대신
//   history: [{ id, slug, shopName, result(AUTO_APPROVED·APPROVED·REJECTED), at, receivedAt, reason, industry, applicantName, undoableUntil }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const g = (k: string) => p.get(k);
    const r = await listApplications(prisma, admin, { tab: g("tab"), sort: g("sort"), q: g("q"), field: g("field"), industry: g("industry"), receivedFrom: g("receivedFrom"), receivedTo: g("receivedTo"), cursor: g("cursor"), limit: g("limit") });
    if (!r.ok) return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
