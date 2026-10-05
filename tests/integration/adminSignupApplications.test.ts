import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as approveRoute } from "../../app/api/admin/sellers/[sellerId]/approve/route";
import { POST as undoRoute } from "../../app/api/admin/sellers/[sellerId]/approve/undo/route";
import { DELETE as cancelRoute, POST as supplementRoute } from "../../app/api/admin/sellers/[sellerId]/supplement/route";
import { POST as remindRoute } from "../../app/api/admin/sellers/[sellerId]/supplement/remind/route";
import { GET as listRoute } from "../../app/api/admin/sellers/applications/route";
import { POST as bulkApproveRoute } from "../../app/api/admin/sellers/applications/bulk-approve/route";
import { POST as bulkRejectRoute } from "../../app/api/admin/sellers/applications/bulk-reject/route";
import { SUPPLEMENT_DAYS, SUPPLEMENT_EXPIRED_REASON, REMINDER_MAX, rejectExpiredSupplements } from "../../lib/server/admin/signupApplications";
import { createAdminSession } from "../../lib/server/auth/session";
import { createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 가입 신청(MA-013): 목록·KPI·탭, 보완 요청·재촉·자동 반려, 선택 승인·반려, 승인 되돌리기(10초)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
type IdRoute = (req: Request, ctx: { params: Promise<{ sellerId: string }> }) => Promise<Response>;
const call = (route: IdRoute, method: string, cookie: string, id: string, path: string, body?: unknown) =>
  route(new Request(`http://localhost:3000/api/admin/sellers/${id}/${path}`, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), {
    params: Promise.resolve({ sellerId: id }),
  });
const list = (cookie: string, qs = "") => listRoute(new Request(`http://localhost:3000/api/admin/sellers/applications${qs}`, { headers: { ...H, cookie } }));
const bulk = (route: (req: Request) => Promise<Response>, cookie: string, body: unknown) =>
  route(new Request("http://localhost:3000/api/admin/sellers/applications/bulk", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
type Item = { id: string; state: string; shopName: string; reviewReasons: string[]; undoUntil: string | null; over48h: boolean; supplement: { canRemind: boolean; reminderCount: number; dueAt: string } | null };
const items = async (r: Response) => ((await r.json()) as { items: Item[] }).items;

let n = 0;
// 승인 대기 신청 한 건(대표자 계정 포함). 접수 시각은 hoursAgo 시간 전.
async function pending(opts: { hoursAgo?: number; reasons?: string[]; name?: string; category?: string | null } = {}) {
  const { seller } = await createSeller();
  n++;
  const plans = await seedPlans();
  await db.seller.update({
    where: { id: seller.id },
    data: {
      status: "PENDING",
      shopName: opts.name ?? `신청몰${n}`,
      planId: plans.OVERLAY_ONLY.id,
      reviewReasons: opts.reasons ?? ["business_not_active"],
      businessCategory: opts.category === undefined ? "TCG 브레이크" : opts.category,
      createdAt: new Date(Date.now() - (opts.hoursAgo ?? 1) * 3_600_000),
      businessInfo: { businessNumber: `123456789${n % 10}`, companyName: `회사${n}`, representativeName: `대표${n}` },
    },
  });
  const owner = await createSellerUser(seller.id, "OWNER", `owner${n}@example.com`);
  return { id: seller.id, ownerEmail: owner.email };
}
const ago = (ms: number) => new Date(Date.now() - ms);

describe("목록·KPI GET /api/admin/sellers/applications", () => {
  it("확인 필요 탭은 오래된 순(기본)·최근 순, 신청자·사업자·업종·걸린 항목·48시간 초과를 주고 보완 요청 건은 빠진다. 모든 마스터 역할이 조회", async () => {
    const a = await pending({ hoursAgo: 72, reasons: ["business_not_active", "mail_order_not_registered"] });
    const b = await pending({ hoursAgo: 5, category: null });
    const c = await pending({ hoursAgo: 30 });
    await db.seller.update({ where: { id: c.id }, data: { supplementRequestedAt: new Date(), supplementMessage: "휴대폰 본인확인 필요" } });
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as Role[]) {
      const { cookie } = await admin(role);
      expect((await items(await list(cookie))).map((i) => i.id)).toEqual([a.id, b.id]);
    }
    const { cookie } = await admin("READ_ONLY");
    const body = (await (await list(cookie)).json()) as { items: Record<string, unknown>[]; counts: Record<string, number>; total: number };
    expect(body.items[0]).toMatchObject({
      id: a.id,
      state: "REVIEW",
      applicant: { name: expect.stringMatching(/^대표/), email: a.ownerEmail },
      businessNumber: expect.stringMatching(/^123456789/),
      businessCategory: "TCG 브레이크",
      reviewReasons: ["business_not_active", "mail_order_not_registered"],
      over48h: true,
      supplement: null,
      undoUntil: null,
    });
    expect(body.items[1]).toMatchObject({ businessCategory: null, over48h: false });
    expect(body.counts).toMatchObject({ review: 2, supplement: 1, history: 0 });
    expect(body.total).toBe(2);
    expect((await items(await list(cookie, "?sort=new"))).map((i) => i.id)).toEqual([b.id, a.id]);
    // 대표자 휴대폰·본인확인 해시는 목록에 없다
    const raw = JSON.stringify(body);
    for (const key of ["phone", "representativeCiHash", "passwordHash"]) expect(raw).not.toContain(key);
  });

  it("KPI: 확인 필요·48시간 초과·보완 요청·오늘 접수·오늘 승인·자동 승인·반려·평균 처리(분). 달·날짜는 KST", async () => {
    const { cookie, id: adminId } = await admin("OPERATIONS");
    await pending({ hoursAgo: 60 }); // 확인 필요 + 48시간 초과
    await pending({ hoursAgo: 2 }); // 확인 필요
    const sup = await pending({ hoursAgo: 10 });
    await db.seller.update({ where: { id: sup.id }, data: { supplementRequestedAt: new Date(), supplementMessage: "보완" } });
    // 마스터가 승인(접수 4시간 → 지금) · 마스터 반려(접수 2시간 → 지금) · 자동 승인(접수 즉시)
    const ok = await pending({ hoursAgo: 4 });
    await db.seller.update({ where: { id: ok.id }, data: { status: "ACTIVE", approvedAt: new Date(), approvedByAdminId: adminId } });
    const no = await pending({ hoursAgo: 2 });
    await db.seller.update({ where: { id: no.id }, data: { status: "REJECTED", rejectedAt: new Date(), rejectedReason: "서류 부족" } });
    const auto = await pending({ hoursAgo: 0 });
    await db.seller.update({ where: { id: auto.id }, data: { status: "ACTIVE", approvedAt: new Date(), approvedByAdminId: null, reviewReasons: [] } });
    // 전달 승인·반려(이번 달 집계에서 빠짐)
    const old = await pending({ hoursAgo: 24 * 40 });
    await db.seller.update({ where: { id: old.id }, data: { status: "REJECTED", rejectedAt: ago(24 * 39 * 3_600_000), rejectedReason: "지난달" } });
    const { kpi } = (await (await list(cookie)).json()) as { kpi: Record<string, number | null> };
    expect(kpi).toMatchObject({ pendingReview: 2, overdue48h: 1, supplementRequested: 1, approvedToday: 1, autoApprovedToday: 1, autoApprovedMonth: 1, rejectedToday: 1, rejectedMonth: 1 });
    expect(kpi.receivedToday).toBeGreaterThanOrEqual(1);
    // 평균 처리 = (4시간 + 2시간) / 2 = 180분(이번 달 마스터 처리분만)
    expect(kpi.avgProcessingMinutes).toBeGreaterThanOrEqual(179);
    expect(kpi.avgProcessingMinutes).toBeLessThanOrEqual(181);
  });

  it("이력 탭: 자동 승인·승인·반려를 처리 시각 최근 순으로, result로 거른다. 검색(와일드카드 문자는 글자로)·쪽 이동·잘못된 값 400", async () => {
    const { cookie, id: adminId } = await admin("SUPER_ADMIN");
    const auto = await pending({ name: "자동승인몰" });
    await db.seller.update({ where: { id: auto.id }, data: { status: "ACTIVE", approvedAt: ago(3_000), approvedByAdminId: null, reviewReasons: [] } });
    const manual = await pending({ name: "수동승인몰" });
    await db.seller.update({ where: { id: manual.id }, data: { status: "ACTIVE", approvedAt: ago(2_000), approvedByAdminId: adminId } });
    const rej = await pending({ name: "반려몰%" });
    await db.seller.update({ where: { id: rej.id }, data: { status: "REJECTED", rejectedAt: ago(1_000), rejectedReason: "사업자 폐업" } });
    await pending({ name: "대기몰" });
    const hist = await items(await list(cookie, "?tab=history"));
    expect(hist.map((i) => [i.state, i.shopName])).toEqual([
      ["REJECTED", "반려몰%"],
      ["APPROVED", "수동승인몰"],
      ["AUTO_APPROVED", "자동승인몰"],
    ]);
    expect(hist[0]).toMatchObject({ rejectedReason: "사업자 폐업" });
    expect((await items(await list(cookie, "?tab=history&result=auto"))).map((i) => i.shopName)).toEqual(["자동승인몰"]);
    expect((await items(await list(cookie, "?tab=history&result=approved"))).map((i) => i.shopName)).toEqual(["수동승인몰"]);
    expect((await items(await list(cookie, "?tab=history&result=rejected"))).map((i) => i.shopName)).toEqual(["반려몰%"]);
    expect((await items(await list(cookie, "?tab=history&sort=old"))).map((i) => i.state)).toEqual(["AUTO_APPROVED", "APPROVED", "REJECTED"]);
    // % 한 글자는 모든 신청이 아니라 이름에 %가 든 신청만
    expect((await items(await list(cookie, `?tab=history&q=${encodeURIComponent("%")}`))).map((i) => i.shopName)).toEqual(["반려몰%"]);
    expect((await items(await list(cookie, "?tab=history&q=" + encodeURIComponent("owner")))).length).toBe(3);
    const p1 = (await (await list(cookie, "?tab=history&limit=2")).json()) as { items: Item[]; nextCursor: string | null; total: number };
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(3);
    const p2 = (await (await list(cookie, `?tab=history&limit=2&cursor=${p1.nextCursor}`)).json()) as { items: Item[]; nextCursor: string | null };
    expect(p2.items.map((i) => i.id)).toEqual([auto.id]);
    expect(p2.nextCursor).toBeNull();
    for (const qs of ["?tab=nope", "?sort=x", "?result=auto", "?tab=history&result=x", "?limit=0", "?limit=101", "?cursor=-1", "?cursor=abc", `?q=${"가".repeat(51)}`]) {
      expect((await list(cookie, qs)).status, qs).toBe(400);
    }
  });

  it("관리자 세션이 없으면 401", async () => {
    expect((await list("")).status).toBe(401);
  });
});

describe("보완 요청·재촉·자동 반려", () => {
  it("보완 요청: 안내 문구 필수, 승인 대기만, 한 번만. 요청하면 보완 요청 탭으로 가고 기한(7일)을 준다. 취소하면 돌아온다", async () => {
    const { cookie } = await admin("OPERATIONS");
    const a = await pending();
    expect((await call(supplementRoute, "POST", cookie, a.id, "supplement", { message: " " })).status).toBe(400);
    expect((await call(supplementRoute, "POST", cookie, a.id, "supplement", {})).status).toBe(400);
    const ok = await call(supplementRoute, "POST", cookie, a.id, "supplement", { message: "휴대폰 본인확인이 끝나지 않았습니다" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { requestedAt: string; dueAt: string };
    expect(Date.parse(body.dueAt) - Date.parse(body.requestedAt)).toBe(SUPPLEMENT_DAYS * 86_400_000);
    expect(await (await call(supplementRoute, "POST", cookie, a.id, "supplement", { message: "다시" })).json()).toMatchObject({ error: "already_requested" });
    expect((await items(await list(cookie))).map((i) => i.id)).toEqual([]);
    const sup = await items(await list(cookie, "?tab=supplement"));
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ id: a.id, state: "SUPPLEMENT", supplement: { message: "휴대폰 본인확인이 끝나지 않았습니다", reminderCount: 0, canRemind: true } });
    expect(await db.auditLog.count({ where: { action: "admin.seller.supplement_request", targetId: a.id } })).toBe(1);
    expect((await call(cancelRoute as unknown as IdRoute, "DELETE", cookie, a.id, "supplement")).status).toBe(200);
    expect((await call(cancelRoute as unknown as IdRoute, "DELETE", cookie, a.id, "supplement")).status).toBe(409);
    expect((await items(await list(cookie))).map((i) => i.id)).toEqual([a.id]);
    // 승인 대기가 아니면 409, 없는 신청은 404
    await db.seller.update({ where: { id: a.id }, data: { status: "ACTIVE" } });
    expect(await (await call(supplementRoute, "POST", cookie, a.id, "supplement", { message: "x" })).json()).toMatchObject({ error: "not_pending" });
    expect((await call(supplementRoute, "POST", cookie, "00000000-0000-4000-8000-000000000000", "supplement", { message: "x" })).status).toBe(404);
    expect((await call(supplementRoute, "POST", cookie, "bad", "supplement", { message: "x" })).status).toBe(404);
  });

  it("재촉 메일: 요청 뒤 24시간이 지나야 하고 최대 3번, 기록만 남긴다(RECORDED). 요청 없는 신청은 409", async () => {
    const { cookie } = await admin("SUPER_ADMIN");
    const a = await pending();
    expect(await (await call(remindRoute, "POST", cookie, a.id, "supplement/remind")).json()).toMatchObject({ error: "not_requested" });
    await call(supplementRoute, "POST", cookie, a.id, "supplement", { message: "사업자등록증 사진이 흐립니다" });
    const early = await call(remindRoute, "POST", cookie, a.id, "supplement/remind");
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: "too_soon", nextReminderAt: expect.any(String) });
    for (let i = 1; i <= REMINDER_MAX; i++) {
      // 마지막 요청·재촉을 25시간 전으로 당긴다
      await db.seller.update({ where: { id: a.id }, data: { supplementRequestedAt: ago(25 * 3_600_000 * i), supplementRemindedAt: i === 1 ? null : ago(25 * 3_600_000) } });
      const r = await call(remindRoute, "POST", cookie, a.id, "supplement/remind");
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ reminderCount: i, delivery: "RECORDED" });
    }
    await db.seller.update({ where: { id: a.id }, data: { supplementRemindedAt: ago(25 * 3_600_000) } });
    expect(await (await call(remindRoute, "POST", cookie, a.id, "supplement/remind")).json()).toMatchObject({ error: "reminder_limit" });
    const sup = await items(await list(cookie, "?tab=supplement"));
    expect(sup[0].supplement).toMatchObject({ reminderCount: REMINDER_MAX, canRemind: false });
    expect(await db.auditLog.count({ where: { action: "admin.seller.supplement_remind", targetId: a.id } })).toBe(REMINDER_MAX);
  });

  it("보완 요청 7일이 지난 신청만 자동 반려(시스템 처리). 요청 없는 신청·기한 안 신청은 그대로", async () => {
    const stale = await pending();
    const fresh = await pending();
    const plain = await pending({ hoursAgo: 24 * 30 });
    await db.seller.update({ where: { id: stale.id }, data: { supplementRequestedAt: ago((SUPPLEMENT_DAYS * 24 + 1) * 3_600_000), supplementMessage: "보완" } });
    await db.seller.update({ where: { id: fresh.id }, data: { supplementRequestedAt: ago(6 * 86_400_000), supplementMessage: "보완" } });
    expect(await rejectExpiredSupplements(db, new Date())).toBe(1);
    expect(await rejectExpiredSupplements(db, new Date())).toBe(0);
    expect(await db.seller.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "REJECTED", rejectedReason: SUPPLEMENT_EXPIRED_REASON, rejectedAt: expect.any(Date) });
    expect((await db.seller.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("PENDING");
    expect((await db.seller.findUniqueOrThrow({ where: { id: plain.id } })).status).toBe("PENDING");
    expect(await db.auditLog.findFirst({ where: { action: "seller.supplement_expired_reject", targetId: stale.id } })).toMatchObject({ actorType: "SYSTEM" });
  });
});

describe("선택 승인·선택 반려", () => {
  it("건별 결과: 한 건이 실패해도 나머지는 처리한다. 확인 필요 사유가 남은 신청은 confirmReviewed 없이는 needs_review", async () => {
    const { cookie, id: adminId } = await admin("OPERATIONS");
    const clean = await pending({ reasons: [] });
    const flagged = await pending();
    const done = await pending({ reasons: [] });
    await db.seller.update({ where: { id: done.id }, data: { status: "ACTIVE" } });
    const ghost = "00000000-0000-4000-8000-000000000000";
    const r1 = (await (await bulk(bulkApproveRoute, cookie, { sellerIds: [clean.id, flagged.id, done.id, ghost, "bad", clean.id] })).json()) as {
      results: { sellerId: string; ok: boolean; reason?: string }[];
      succeeded: number;
      failed: number;
    };
    expect(r1.results).toEqual([
      { sellerId: clean.id, ok: true },
      { sellerId: flagged.id, ok: false, reason: "needs_review" },
      { sellerId: done.id, ok: false, reason: "not_pending" },
      { sellerId: ghost, ok: false, reason: "not_found" },
      { sellerId: "bad", ok: false, reason: "not_found" },
    ]);
    expect([r1.succeeded, r1.failed]).toEqual([1, 4]);
    expect(await db.seller.findUniqueOrThrow({ where: { id: clean.id } })).toMatchObject({ status: "ACTIVE", approvedByAdminId: adminId });
    expect((await db.seller.findUniqueOrThrow({ where: { id: flagged.id } })).status).toBe("PENDING");
    const r2 = (await (await bulk(bulkApproveRoute, cookie, { sellerIds: [flagged.id], confirmReviewed: true })).json()) as { succeeded: number };
    expect(r2.succeeded).toBe(1);
    expect((await db.seller.findUniqueOrThrow({ where: { id: flagged.id } })).status).toBe("ACTIVE");
    expect(await db.auditLog.count({ where: { action: "admin.seller.approve", targetId: { in: [clean.id, flagged.id] } } })).toBe(2);
  });

  it("선택 반려: 같은 사유로 건별 처리, 사유 필수. 1~50건만, 중복은 한 번", async () => {
    const { cookie } = await admin("SUPER_ADMIN");
    const a = await pending();
    const b = await pending();
    expect((await bulk(bulkRejectRoute, cookie, { sellerIds: [a.id], reason: " " })).status).toBe(400);
    const r = (await (await bulk(bulkRejectRoute, cookie, { sellerIds: [a.id, b.id, a.id], reason: "사업자 폐업" })).json()) as { results: unknown[]; succeeded: number };
    expect(r.results).toHaveLength(2);
    expect(r.succeeded).toBe(2);
    expect(await db.seller.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "REJECTED", rejectedReason: "사업자 폐업" });
    for (const route of [bulkApproveRoute, bulkRejectRoute]) {
      expect((await bulk(route, cookie, { sellerIds: [], reason: "x" })).status).toBe(400);
      expect((await bulk(route, cookie, { sellerIds: Array.from({ length: 51 }, () => a.id), reason: "x" })).status).toBe(400);
      expect((await bulk(route, cookie, { sellerIds: "nope", reason: "x" })).status).toBe(400);
    }
  });

  it("조회 전용·CS는 변경 전부 403(처리·상태 변화 없음), 운영·최고관리자만 가능", async () => {
    const a = await pending({ reasons: [] });
    await db.seller.update({ where: { id: a.id }, data: { supplementRequestedAt: ago(30 * 3_600_000), supplementMessage: "보완" } });
    for (const role of ["READ_ONLY", "CS"] as Role[]) {
      const { cookie } = await admin(role);
      expect((await bulk(bulkApproveRoute, cookie, { sellerIds: [a.id] })).status).toBe(403);
      expect((await bulk(bulkRejectRoute, cookie, { sellerIds: [a.id], reason: "x" })).status).toBe(403);
      expect((await call(supplementRoute, "POST", cookie, a.id, "supplement", { message: "x" })).status).toBe(403);
      expect((await call(remindRoute, "POST", cookie, a.id, "supplement/remind")).status).toBe(403);
      expect((await call(undoRoute, "POST", cookie, a.id, "approve/undo")).status).toBe(403);
    }
    expect((await db.seller.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("PENDING");
  });
});

describe("승인 되돌리기(10초)", () => {
  it("방금 내가 승인한 신청을 승인 대기로 되돌리고 확인 필요 사유를 되살린다. 승인 직후 목록에는 되돌릴 수 있는 시각이 보인다", async () => {
    const { cookie } = await admin("OPERATIONS");
    const a = await pending({ reasons: ["business_not_active", "mail_order_not_registered"] });
    expect((await call(approveRoute, "POST", cookie, a.id, "approve")).status).toBe(200);
    expect((await db.seller.findUniqueOrThrow({ where: { id: a.id } })).reviewReasons).toEqual([]);
    const hist = await items(await list(cookie, "?tab=history"));
    expect(hist[0]).toMatchObject({ id: a.id, state: "APPROVED", undoUntil: expect.any(String) });
    const r = await call(undoRoute, "POST", cookie, a.id, "approve/undo");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, reviewReasons: ["business_not_active", "mail_order_not_registered"] });
    expect(await db.seller.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "PENDING",
      approvedAt: null,
      approvedByAdminId: null,
      trialEndsAt: null,
      reviewReasons: ["business_not_active", "mail_order_not_registered"],
    });
    expect((await items(await list(cookie))).map((i) => i.id)).toEqual([a.id]);
    expect((await items(await list(cookie, "?tab=history")))).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "admin.seller.approve_undo", targetId: a.id } })).toBe(1);
    // 다시 승인할 수 있다
    expect((await call(approveRoute, "POST", cookie, a.id, "approve")).status).toBe(200);
    // 이미 되돌릴 수 없는 상태(승인 대기)에서는 409
    await call(undoRoute, "POST", cookie, a.id, "approve/undo");
    expect((await call(undoRoute, "POST", cookie, a.id, "approve/undo")).status).toBe(409);
  });

  it("10초가 지났거나 다른 관리자가 승인한 건, 이미 구독이 생긴 건은 409 not_undoable(상태 그대로)", async () => {
    const plans = await seedPlans();
    const me = await admin("OPERATIONS");
    const other = await admin("SUPER_ADMIN");
    const late = await pending({ reasons: [] });
    const theirs = await pending({ reasons: [] });
    const subscribed = await pending({ reasons: [] });
    for (const x of [late, theirs, subscribed]) expect((await call(approveRoute, "POST", x === theirs ? other.cookie : me.cookie, x.id, "approve")).status).toBe(200);
    await db.seller.update({ where: { id: late.id }, data: { approvedAt: ago(11_000) } });
    await db.sellerSubscription.create({
      data: { sellerId: subscribed.id, planId: plans.OVERLAY_ONLY.id, status: "ACTIVE", currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000), nextChargeAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    for (const x of [late, theirs, subscribed]) {
      const r = await call(undoRoute, "POST", me.cookie, x.id, "approve/undo");
      expect(r.status, x.id).toBe(409);
      expect(await r.json()).toEqual({ error: "not_undoable" });
      expect((await db.seller.findUniqueOrThrow({ where: { id: x.id } })).status).toBe("ACTIVE");
    }
    // 목록의 되돌리기 시각은 내가 승인한 건에만, 시간이 지나면 사라진다
    const hist = await items(await list(me.cookie, "?tab=history"));
    expect(hist.find((i) => i.id === theirs.id)?.undoUntil).toBeNull();
    expect(hist.find((i) => i.id === late.id)?.undoUntil).toBeNull();
    expect((await call(undoRoute, "POST", me.cookie, "00000000-0000-4000-8000-000000000000", "approve/undo")).status).toBe(404);
  });
});
