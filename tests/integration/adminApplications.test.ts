import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "../../app/api/admin/sellers/applications/route";
import { POST as bulkRoute } from "../../app/api/admin/sellers/applications/bulk-approve/route";
import { POST as bulkRejectRoute } from "../../app/api/admin/sellers/applications/bulk-reject/route";
import { POST as approveRoute } from "../../app/api/admin/sellers/[sellerId]/approve/route";
import { POST as undoRoute } from "../../app/api/admin/sellers/[sellerId]/approve/undo/route";
import { POST as remindRoute } from "../../app/api/admin/sellers/[sellerId]/remind/route";
import { POST as supplementRoute } from "../../app/api/admin/sellers/[sellerId]/supplement/route";
import { POST as resolveRoute } from "../../app/api/admin/sellers/[sellerId]/supplement/resolve/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { rejectExpiredSupplements, remindSupplement, undoApproval } from "../../lib/server/sellers/applications";
import { FakeMailSender } from "../../lib/server/mail/registry";
import { createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 가입 신청(MA-013): 목록·KPI·이력, 보완 요청·재촉 메일·선택 승인·승인 되돌리기(10초)·보완 기한 자동 반려. 조회는 모든 마스터 역할, 변경은 최고관리자·운영.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const list = async (cookie: string, qs = "") => {
  const r = await listRoute(new Request(`http://localhost:3000/api/admin/sellers/applications${qs}`, { headers: { ...H, cookie } }));
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const post = async (route: (req: Request, ctx: { params: Promise<{ sellerId: string }> }) => Promise<Response>, cookie: string, id: string, body?: unknown) => {
  const r = await route(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body ?? {}) }), { params: Promise.resolve({ sellerId: id }) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const bulk = async (cookie: string, ids: unknown) => {
  const r = await bulkRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ ids }) }));
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const HOUR = 3_600_000;

async function pending(over: { name?: string; reasons?: string[]; ageHours?: number; industry?: string; biz?: string; rep?: string; email?: string } = {}) {
  await seedPlans();
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER", over.email ?? `o${seller.slug}@example.com`);
  await db.seller.update({
    where: { id: seller.id },
    data: {
      status: "PENDING",
      shopName: over.name ?? seller.shopName,
      reviewReasons: over.reasons ?? [],
      createdAt: new Date(Date.now() - (over.ageHours ?? 1) * HOUR),
      businessInfo: { representativeName: over.rep ?? "홍길동", businessNumber: over.biz ?? "123-45-67890", industry: over.industry ?? "TCG 브레이크" },
    },
  });
  return { seller, owner };
}

describe("가입 신청 목록 GET /api/admin/sellers/applications", () => {
  it("상태 3종(이상 없음·확인 필요·보완 요청)·칩·KPI·48시간 초과·업종 목록. 검색·필터·정렬·쪽 이동. 잘못된 값 400", async () => {
    const { cookie, id } = await admin("OPERATIONS");
    const clear = await pending({ name: "이상없음몰", ageHours: 5, industry: "굿즈 라이브" });
    const review = await pending({ name: "확인필요몰", reasons: ["business_not_active"], ageHours: 60, rep: "김철수", biz: "111-22-33333", email: "kim@example.com" });
    const supp = await pending({ name: "보완몰", reasons: ["mail_order_number_invalid"], ageHours: 100 });
    expect((await post(supplementRoute, cookie, supp.seller.id, { reason: "사업자등록증 사진이 흐립니다" })).status).toBe(200);
    await pending({ name: "오늘접수몰", ageHours: 0.2 });
    // 이력 재료: 자동 승인 1·반려 1(이번 달)
    const { seller: auto } = await createSeller();
    await db.seller.update({ where: { id: auto.id }, data: { approvedAt: new Date(), approvedByAdminId: null, createdAt: new Date(Date.now() - HOUR) } });
    const { seller: rej } = await createSeller();
    await db.seller.update({ where: { id: rej.id }, data: { status: "REJECTED", rejectedAt: new Date(), rejectedReason: "사업자 폐업", createdAt: new Date(Date.now() - 3 * HOUR), approvedByAdminId: id } });

    const r = await list(cookie);
    expect(r.status).toBe(200);
    // 오늘 접수는 한국 날짜 기준이라 시험 시각에 따라 달라진다 → 같은 기준으로 센 값과 비교한다
    const kstNow = new Date(Date.now() + 9 * HOUR);
    const dayStart = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * HOUR);
    const today = await db.seller.count({ where: { status: "PENDING", createdAt: { gte: dayStart } } });
    expect(r.body.chips).toEqual({ all: 4, clear: 2, review: 1, supplement: 1, over48h: 1, today });
    expect(r.body.kpi).toMatchObject({ pending: 4, needsReview: 1, clear: 2, supplement: 1, over48h: 1, autoApprovedToday: 1, autoApprovedMonth: 1, rejectedToday: 1, rejectedMonth: 1 });
    expect(r.body.kpi.avgHandlingHours.thisWeek).toBeGreaterThan(0);
    expect(r.body.industries).toEqual(["TCG 브레이크", "굿즈 라이브"].sort());
    // 기본 정렬은 오래된 순
    expect(r.body.applications.map((a: any) => a.shopName)).toEqual(["보완몰", "확인필요몰", "이상없음몰", "오늘접수몰"]);
    const by = new Map<string, any>(r.body.applications.map((a: any) => [a.shopName, a]));
    expect(by.get("확인필요몰")).toMatchObject({ state: "REVIEW", applicantName: "김철수", applicantEmail: "kim@example.com", businessNumber: "111-22-33333", over48h: true, reasons: [{ code: "business_not_active", text: "사업자 상태가 휴업 또는 폐업입니다" }], supplement: null });
    expect(by.get("이상없음몰")).toMatchObject({ state: "CLEAR", industry: "굿즈 라이브", over48h: false, reasons: [] });
    // 점검 항목별 결과(검토 패널): 휴업 사유는 국세청 사업자 상태만 FAIL, 나머지는 통과
    expect(by.get("확인필요몰")?.checks).toEqual([
      { key: "identity", label: "휴대폰 본인확인 (대표자)", result: "OK", text: "완료" },
      { key: "business_duplicate", label: "사업자 중복", result: "OK", text: "없음" },
      { key: "business_status", label: "국세청 사업자 상태", result: "FAIL", text: "휴업 · 폐업" },
      { key: "mail_order", label: "통신판매업 신고번호", result: "OK", text: "확인됨" },
    ]);
    expect(by.get("이상없음몰")?.checks.every((c: { result: string }) => c.result === "OK")).toBe(true);
    expect(by.get("보완몰")).toMatchObject({ state: "SUPPLEMENT", over48h: false, supplement: { reason: "사업자등록증 사진이 흐립니다", daysLeft: 7, reminderCount: 0 } });

    const ids = async (qs: string) => (await list(cookie, qs)).body.applications.map((a: any) => a.shopName);
    expect(await ids("?tab=clear")).toEqual(["이상없음몰", "오늘접수몰"]);
    expect(await ids("?tab=review")).toEqual(["확인필요몰"]);
    expect(await ids("?tab=supplement")).toEqual(["보완몰"]);
    expect(await ids("?tab=over48h")).toEqual(["확인필요몰"]);
    expect(await ids("?sort=newest&tab=clear")).toEqual(["오늘접수몰", "이상없음몰"]);
    expect(await ids(`?industry=${encodeURIComponent("굿즈 라이브")}`)).toEqual(["이상없음몰"]);
    expect(await ids(`?q=${encodeURIComponent("김철")}&field=applicant`)).toEqual(["확인필요몰"]);
    expect(await ids("?q=kim@&field=applicant")).toEqual(["확인필요몰"]);
    expect(await ids("?q=1112233333&field=biz")).toEqual(["확인필요몰"]);
    expect(await ids(`?q=${encodeURIComponent("김철")}&field=shop`)).toEqual([]);
    expect(await ids(`?q=${encodeURIComponent("보완")}`)).toEqual(["보완몰"]);
    const p1 = await list(cookie, "?limit=3");
    expect(p1.body.total).toBe(4);
    const p2 = await list(cookie, `?limit=3&cursor=${p1.body.nextCursor}`);
    expect([...p1.body.applications, ...p2.body.applications]).toHaveLength(4);
    expect(p2.body.nextCursor).toBeNull();
    // 이력: 자동 승인·반려(최근 30일)
    const h = await list(cookie, "?tab=history");
    expect(h.body.history.map((x: any) => x.result).sort()).toEqual(["AUTO_APPROVED", "REJECTED"]);
    expect(h.body.history.find((x: any) => x.result === "REJECTED")).toMatchObject({ reason: "사업자 폐업" });
    for (const qs of ["?tab=x", "?sort=x", "?field=x", "?limit=0", "?cursor=bad", "?receivedFrom=2026-13-01", `?q=${"가".repeat(51)}`]) expect((await list(cookie, qs)).status).toBe(400);
  });

  it("모든 마스터 역할이 보고, 로그인 없음 401", async () => {
    await pending();
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) expect((await list((await admin(role)).cookie)).status).toBe(200);
    expect((await list("")).status).toBe(401);
  });
});

describe("보완 요청·재촉 메일", () => {
  it("보완 요청(사유 필수·중복 409·처리된 신청 409) → 재촉 메일 하루 한 번 → 보완 확인으로 풀림. 변경은 최고관리자·운영만", async () => {
    const op = await admin("OPERATIONS");
    const s = await pending({ reasons: ["business_not_active"] });
    for (const role of ["CS", "READ_ONLY"] as const) expect((await post(supplementRoute, (await admin(role)).cookie, s.seller.id, { reason: "x" })).status).toBe(403);
    expect((await post(supplementRoute, op.cookie, s.seller.id, {})).status).toBe(400);
    expect((await post(supplementRoute, op.cookie, s.seller.id, { reason: "가".repeat(201) })).status).toBe(400);
    expect((await post(supplementRoute, op.cookie, "00000000-0000-4000-8000-000000000000", { reason: "x" })).status).toBe(404);
    const ok = await post(supplementRoute, op.cookie, s.seller.id, { reason: "재개업 증빙을 올려 주십시오" });
    expect(ok.status).toBe(200);
    const row = await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    expect(row.supplementDueAt!.getTime() - row.supplementRequestedAt!.getTime()).toBe(7 * 24 * HOUR);
    expect(await post(supplementRoute, op.cookie, s.seller.id, { reason: "또" })).toMatchObject({ status: 409, body: { error: "already_requested" } });

    // 재촉 메일: 보낸 때만 횟수, 하루 한 번
    const first = await post(remindRoute, op.cookie, s.seller.id);
    expect(first).toMatchObject({ status: 200, body: { reminderCount: 1 } });
    const again = await post(remindRoute, op.cookie, s.seller.id);
    expect(again).toMatchObject({ status: 409, body: { error: "remind_too_soon" } });
    expect(again.body.canRemindAt).toBeTruthy();
    expect((await post(remindRoute, (await admin("CS")).cookie, s.seller.id)).status).toBe(403);
    const audit = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "admin.seller.supplement_remind" } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("@example.com");

    expect((await list(op.cookie, "?tab=supplement")).body.applications[0].supplement).toMatchObject({ reminderCount: 1 });
    expect(await post(resolveRoute, op.cookie, s.seller.id)).toMatchObject({ status: 200 });
    expect(await post(resolveRoute, op.cookie, s.seller.id)).toMatchObject({ status: 409, body: { error: "not_requested" } });
    expect((await list(op.cookie, "?tab=review")).body.applications.map((a: any) => a.id)).toEqual([s.seller.id]);
    // 보완 요청을 풀면 다시 요청할 수 있고 재촉 횟수는 0부터
    expect((await post(supplementRoute, op.cookie, s.seller.id, { reason: "다시" })).status).toBe(200);
    expect((await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).reminderCount).toBe(0);
  });

  it("메일 공급자가 없으면 503 상태로 보내지 않고 횟수도 세지 않으며, 실패한 발송도 세지 않는다. 승인 대기가 아니면 409", async () => {
    const op = await admin("SUPER_ADMIN");
    const s = await pending();
    await post(supplementRoute, op.cookie, s.seller.id, { reason: "서류 보완" });
    const session = await (async () => {
      const { resolveAdminSession } = await import("../../lib/server/auth/session");
      return (await resolveAdminSession(db, op.cookie.replace("lo_admin=", "")))!;
    })();
    expect(await remindSupplement(prisma, session, s.seller.id, { sender: null })).toMatchObject({ ok: false, reason: "mail_unavailable" });
    const failing = { send: async () => { throw new Error("smtp down"); } };
    expect(await remindSupplement(prisma, session, s.seller.id, { sender: failing })).toMatchObject({ ok: false, reason: "mail_failed" });
    expect((await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).reminderCount).toBe(0);
    const fake = new FakeMailSender();
    expect(await remindSupplement(prisma, session, s.seller.id, { sender: fake })).toMatchObject({ ok: true, reminderCount: 1 });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].subject).toContain("보완");
    expect(fake.sent[0].to).toBe(s.owner.email);
    // 승인 대기가 아니면 재촉할 수 없다
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "REJECTED" } });
    expect(await remindSupplement(prisma, session, s.seller.id, { sender: fake })).toMatchObject({ ok: false, reason: "not_pending" });
  });
});

describe("선택 승인·승인 되돌리기", () => {
  it("선택 승인은 이상 없음만 승인하고 확인 필요·보완 요청·없는 건은 건별로 거절하며 나머지는 계속한다. 50건 초과·잘못된 id 400. 권한은 최고관리자·운영", async () => {
    const op = await admin("OPERATIONS");
    const a = await pending();
    const b = await pending();
    const review = await pending({ reasons: ["business_not_active"] });
    const supp = await pending();
    await post(supplementRoute, op.cookie, supp.seller.id, { reason: "보완" });
    const gone = "00000000-0000-4000-8000-000000000000";
    const r = await bulk(op.cookie, [a.seller.id, review.seller.id, supp.seller.id, gone, b.seller.id, a.seller.id]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approved: 2, failed: 3 });
    const by = new Map<string, any>(r.body.results.map((x: any) => [x.id, x]));
    expect(by.get(a.seller.id)).toMatchObject({ ok: true });
    expect(by.get(a.seller.id).undoableUntil).toBeTruthy();
    expect(by.get(review.seller.id)).toMatchObject({ ok: false, reason: "needs_review" });
    expect(by.get(supp.seller.id)).toMatchObject({ ok: false, reason: "needs_review" });
    expect(by.get(gone)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await db.seller.findMany({ where: { id: { in: [a.seller.id, b.seller.id] } }, select: { status: true } })).toEqual([{ status: "ACTIVE" }, { status: "ACTIVE" }]);
    expect((await db.seller.findUniqueOrThrow({ where: { id: review.seller.id } })).status).toBe("PENDING");
    // 이미 승인된 건은 not_pending
    expect((await bulk(op.cookie, [a.seller.id])).body.results[0]).toMatchObject({ ok: false, reason: "not_pending" });
    expect((await bulk(op.cookie, [])).status).toBe(400);
    expect((await bulk(op.cookie, ["x"])).status).toBe(400);
    expect((await bulk(op.cookie, Array.from({ length: 51 }, () => gone))).status).toBe(400);
    for (const role of ["CS", "READ_ONLY"] as const) expect((await bulk((await admin(role)).cookie, [gone])).status).toBe(403);
  });

  it("승인 응답의 undoableUntil 안에서 이 관리자가 되돌릴 수 있고, 걸린 항목이 되살아나며 로그인 세션이 끊긴다. 다른 관리자·자동 승인·10초 지남은 거절", async () => {
    const op = await admin("OPERATIONS");
    const other = await admin("SUPER_ADMIN");
    const s = await pending({ reasons: ["business_not_active"] });
    const ap = await post(approveRoute, op.cookie, s.seller.id);
    expect(ap.status).toBe(200);
    expect(new Date(ap.body.undoableUntil).getTime() - new Date(ap.body.approvedAt).getTime()).toBe(10_000);
    await db.sellerSession.create({ data: { sellerUserId: s.owner.id, sellerId: s.seller.id, tokenHash: "h".repeat(32), expiresAt: new Date(Date.now() + HOUR) } });
    // 다른 관리자는 되돌릴 수 없다
    expect(await post(undoRoute, other.cookie, s.seller.id)).toMatchObject({ status: 409, body: { error: "not_undoable" } });
    expect((await post(undoRoute, (await admin("CS")).cookie, s.seller.id)).status).toBe(403);
    expect(await post(undoRoute, op.cookie, s.seller.id)).toMatchObject({ status: 200 });
    const back = await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } });
    expect(back).toMatchObject({ status: "PENDING", approvedAt: null, approvedByAdminId: null, trialEndsAt: null, reviewReasons: ["business_not_active"] });
    expect((await db.sellerSession.findMany({ where: { sellerId: s.seller.id } })).every((x) => x.revokedAt)).toBe(true);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "admin.seller.approve_undo" } })).toBe(1);
    // 이미 되돌린 건은 다시 되돌릴 수 없고, 다시 승인할 수 있다
    expect(await post(undoRoute, op.cookie, s.seller.id)).toMatchObject({ status: 409, body: { error: "not_undoable" } });
    expect((await post(approveRoute, op.cookie, s.seller.id)).status).toBe(200);
    // 10초가 지나면 되돌릴 수 없다
    await db.$executeRaw`UPDATE "Seller" SET "approvedAt" = now() - interval '30 seconds' WHERE "id" = ${s.seller.id}::uuid`;
    expect(await post(undoRoute, op.cookie, s.seller.id)).toMatchObject({ status: 409, body: { error: "undo_expired" } });
    expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).status).toBe("ACTIVE");
    // 자동 승인(승인 관리자 없음)은 되돌릴 수 없다
    const auto = await pending();
    await db.seller.update({ where: { id: auto.seller.id }, data: { status: "ACTIVE", approvedAt: new Date(), approvedByAdminId: null } });
    expect(await post(undoRoute, op.cookie, auto.seller.id)).toMatchObject({ status: 409, body: { error: "not_undoable" } });
    expect((await post(undoRoute, op.cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("보완 요청 중인 신청을 승인·반려하면 보완 요청이 풀린다", async () => {
    const op = await admin("OPERATIONS");
    const s = await pending();
    await post(supplementRoute, op.cookie, s.seller.id, { reason: "보완" });
    await post(approveRoute, op.cookie, s.seller.id);
    expect((await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).supplementResolvedAt).toBeTruthy();
  });
});

describe("보완 기한 자동 반려(정기 작업)·선택 반려·재촉 3번 제한", () => {
  it("기한이 지난 보완 요청만 반려하고 사유를 남기며, 기한 전·풀린 건은 그대로다", async () => {
    const op = await admin("OPERATIONS");
    const late = await pending();
    const fresh = await pending();
    const resolved = await pending();
    for (const s of [late, fresh, resolved]) await post(supplementRoute, op.cookie, s.seller.id, { reason: "보완" });
    await post(resolveRoute, op.cookie, resolved.seller.id);
    await db.sellerApplicationReview.updateMany({ where: { sellerId: { in: [late.seller.id, resolved.seller.id] } }, data: { supplementDueAt: new Date(Date.now() - 1000), supplementRequestedAt: new Date(Date.now() - 8 * 24 * HOUR) } });
    // 기한이 지난 신청은 목록에 기한 지남으로 보인다
    expect((await list(op.cookie, "?tab=supplement")).body.applications.find((a: any) => a.id === late.seller.id).supplement).toMatchObject({ dueExpired: true, daysLeft: 0 });
    const n = await db.$transaction((tx) => rejectExpiredSupplements(tx, new Date()));
    expect(n).toBe(1);
    expect(await db.seller.findUniqueOrThrow({ where: { id: late.seller.id } })).toMatchObject({ status: "REJECTED", rejectedReason: expect.stringContaining("자동 반려") });
    expect((await db.seller.findUniqueOrThrow({ where: { id: fresh.seller.id } })).status).toBe("PENDING");
    expect((await db.seller.findUniqueOrThrow({ where: { id: resolved.seller.id } })).status).toBe("PENDING");
    expect(await db.auditLog.count({ where: { sellerId: late.seller.id, action: "seller.supplement_expired" } })).toBe(1);
    expect(await db.$transaction((tx) => rejectExpiredSupplements(tx, new Date()))).toBe(0);
  });

  it("선택 반려: 같은 사유로 건별 처리(없는 건·이미 처리된 건은 실패, 나머지 계속), 사유 필수·50건 제한, 권한 최고관리자·운영, 반려 이력에 사유", async () => {
    const op = await admin("OPERATIONS");
    const a = await pending();
    const b = await pending({ reasons: ["business_not_active"] });
    const done = await pending();
    await post(approveRoute, op.cookie, done.seller.id);
    const gone = "00000000-0000-4000-8000-000000000000";
    const rej = async (cookie: string, body: unknown) => {
      const r = await bulkRejectRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    const r = await rej(op.cookie, { ids: [a.seller.id, gone, done.seller.id, b.seller.id], reason: "사업자 상태 휴업·폐업" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rejected: 2, failed: 2 });
    const by = new Map<string, any>(r.body.results.map((x: any) => [x.id, x]));
    expect(by.get(gone)).toMatchObject({ ok: false, reason: "not_found" });
    expect(by.get(done.seller.id)).toMatchObject({ ok: false, reason: "not_pending" });
    expect(await db.seller.findMany({ where: { id: { in: [a.seller.id, b.seller.id] } }, select: { status: true, rejectedReason: true } })).toEqual([{ status: "REJECTED", rejectedReason: "사업자 상태 휴업·폐업" }, { status: "REJECTED", rejectedReason: "사업자 상태 휴업·폐업" }]);
    expect((await rej(op.cookie, { ids: [gone], reason: "" })).status).toBe(400);
    expect((await rej(op.cookie, { ids: [], reason: "x" })).status).toBe(400);
    expect((await rej(op.cookie, { ids: Array.from({ length: 51 }, () => gone), reason: "x" })).status).toBe(400);
    for (const role of ["CS", "READ_ONLY"] as const) expect((await rej((await admin(role)).cookie, { ids: [gone], reason: "x" })).status).toBe(403);
    const h = await list(op.cookie, "?tab=history&result=rejected");
    expect(h.body.history.map((x: any) => x.result)).toEqual(["REJECTED", "REJECTED"]);
    expect((await list(op.cookie, "?tab=history&result=auto")).body.history).toEqual([]);
    expect((await list(op.cookie, "?tab=history&result=x")).status).toBe(400);
  });

  it("재촉 메일은 하루 한 번에 최대 3번이다", async () => {
    const op = await admin("SUPER_ADMIN");
    const s = await pending();
    await post(supplementRoute, op.cookie, s.seller.id, { reason: "보완" });
    for (let i = 1; i <= 3; i++) {
      expect((await post(remindRoute, op.cookie, s.seller.id)).body.reminderCount).toBe(i);
      await db.sellerApplicationReview.update({ where: { sellerId: s.seller.id }, data: { lastReminderAt: new Date(Date.now() - 25 * HOUR) } });
    }
    expect(await post(remindRoute, op.cookie, s.seller.id)).toMatchObject({ status: 409, body: { error: "remind_limit" } });
    expect((await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).reminderCount).toBe(3);
  });

  it("승인 되돌리기는 시간 안이어도 승인 관리자 본인만(함수 직접 호출도 같다)", async () => {
    const op = await admin("OPERATIONS");
    const s = await pending();
    await post(approveRoute, op.cookie, s.seller.id);
    const { resolveAdminSession } = await import("../../lib/server/auth/session");
    const other = await admin("SUPER_ADMIN");
    const otherSession = (await resolveAdminSession(db, other.cookie.replace("lo_admin=", "")))!;
    expect(await undoApproval(prisma, otherSession, s.seller.id)).toMatchObject({ ok: false, reason: "not_undoable" });
  });
});
