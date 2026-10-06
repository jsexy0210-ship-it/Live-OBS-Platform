import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as todayGet } from "../../app/api/admin/today-tasks/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 「오늘 처리할 일」(MA-001): 7가지 건수와 처리 화면 주소, 전 역할 조회, 파트너스·비로그인 차단.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000" };
const DAY = 86_400_000;
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = (cookie: string) => todayGet(new Request("http://localhost:3000/api/admin/today-tasks", { headers: { ...H, cookie } }));
const counts = (body: { items: { key: string; count: number }[] }) => Object.fromEntries(body.items.map((i) => [i.key, i.count]));

describe("오늘 처리할 일 GET /api/admin/today-tasks", () => {
  it("아무것도 없으면 모두 0, 항목 순서와 처리 화면 주소가 정해져 있다", async () => {
    const r = await get(await adminCookie());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    // 플랫폼 정보(MA-088)가 비어 있으면 그것만 1
    expect(body.total).toBe(1);
    expect(counts(body)).toMatchObject({ platformInfoMissing: 1, signupPending: 0, refundRequested: 0 });
    expect(body.items.map((i: { key: string }) => i.key)).toEqual(["signupPending", "paymentFailed", "refundRequested", "inquiryOpen", "pgError", "automationFailed", "incidentCritical", "platformInfoMissing"]);
    expect(Object.fromEntries(body.items.map((i: { key: string; href: string }) => [i.key, i.href.split("?")[0]]))).toEqual({
      signupPending: "/admin/partners",
      paymentFailed: "/admin/billing/invoices",
      refundRequested: "/admin/billing/refunds",
      inquiryOpen: "/admin/support/inquiries",
      pgError: "/admin/settlement/pg",
      automationFailed: "/admin/ops/automation",
      incidentCritical: "/admin/ops/monitor",
      platformInfoMissing: "/admin/settings/platform-business",
    });
    expect(body.items.find((i: { key: string }) => i.key === "signupPending").href).toBe("/admin/partners?status=PENDING");
    expect(body.items.find((i: { key: string }) => i.key === "refundRequested").href).toBe("/admin/billing/refunds?status=REQUESTED");
    expect(body.items.find((i: { key: string }) => i.key === "paymentFailed").href).toMatch(/^\/admin\/billing\/invoices\?status=FAILED&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  });

  it("건수를 센다: 승인 대기·최근 7일 구독료 실패·환불 요청·답변 대기 문의·PG 오류 파트너스·자동 연결 실패·열린 심각 장애. 지난 것·끝난 것은 뺀다", async () => {
    const plans = await seedPlans();
    const now = Date.now();
    // 승인 대기 2곳(ACTIVE는 제외)
    await db.seller.create({ data: { slug: "wait-1", shopName: "대기1", status: "PENDING" } });
    await db.seller.create({ data: { slug: "wait-2", shopName: "대기2", status: "PENDING" } });
    const a = await createSeller();
    const b = await createSeller();
    const subA = await db.sellerSubscription.create({ data: { sellerId: a.seller.id, planId: plans.INTEGRATED.id } });
    const pay = (status: "PAID" | "FAILED", createdAt: Date) =>
      db.subscriptionPayment.create({ data: { sellerId: a.seller.id, subscriptionId: subA.id, amount: 1000, status, periodStart: createdAt, periodEnd: new Date(createdAt.getTime() + 30 * DAY), createdAt } });
    await pay("FAILED", new Date(now - DAY));
    await pay("FAILED", new Date(now - 10 * DAY)); // 7일 지남
    const paid = await pay("PAID", new Date(now - 20 * DAY));
    await db.subscriptionRefund.create({ data: { sellerId: a.seller.id, paymentId: paid.id, amount: 500, source: "ADMIN", reason: "사유", status: "REQUESTED" } });
    const paid2 = await pay("PAID", new Date(now - 50 * DAY));
    await db.subscriptionRefund.create({ data: { sellerId: a.seller.id, paymentId: paid2.id, amount: 100, source: "ADMIN", reason: "사유", status: "REFUNDED" } });
    // 문의: OPEN 2건, ANSWERED 1건
    const owner = await createSellerUser(a.seller.id, "OWNER");
    for (const status of ["OPEN", "OPEN", "ANSWERED"] as const) {
      await db.platformInquiry.create({ data: { sellerId: a.seller.id, createdBySellerUserId: owner.id, category: "BILLING", title: "문의", status } });
    }
    // PG 오류: A는 24시간 안 결제 실패, B는 취소 실패, 옛 실패(30시간)만 있는 C는 제외, A는 결제 실패+취소 실패가 겹쳐도 1곳
    const c = await createSeller();
    const mk = async (s: { seller: { id: string }; grade: { id: string } }, status: "FAILED" | "PAID", ageH: number, n: number) => {
      const buyer = await createBuyer(s.seller.id, s.grade.id);
      const order = await db.order.create({ data: { sellerId: s.seller.id, orderNo: n, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000 } });
      return db.payment.create({
        data: { sellerId: s.seller.id, orderId: order.id, provider: "nicepay", method: "CARD", status, amount: 10000, approvedAt: status === "PAID" ? new Date(now) : null, updatedAt: new Date(now - ageH * 3_600_000) },
      });
    };
    const pa = await mk(a, "FAILED", 1, 1);
    await db.paymentCancel.create({ data: { sellerId: a.seller.id, paymentId: pa.id, amount: 100, reason: "x", idempotencyKey: "ka", status: "FAILED" } });
    const pb = await mk(b, "PAID", 1, 1);
    await db.paymentCancel.create({ data: { sellerId: b.seller.id, paymentId: pb.id, amount: 100, reason: "x", idempotencyKey: "kb", status: "FAILED" } });
    await mk(c, "FAILED", 30, 1);
    // 자동 연결: FAILED·CLEANUP_NEEDED만
    const ap = (sellerId: string, key: string) =>
      db.automationPayment.create({ data: { sellerId, amount: 1000, status: "PAID", idempotencyKey: key, requestFingerprint: "x", consentNoticeVersion: "x", consentAgreedAt: new Date() } });
    let k = 0;
    for (const status of ["FAILED", "CLEANUP_NEEDED", "QUEUED", "SUCCEEDED"] as const) {
      k++;
      const js = (await createSeller()).seller; // 쇼핑몰마다 진행 중 작업은 하나
      await db.automationJob.create({ data: { sellerId: js.id, obsTargetKey: `obs:${k}`, status, queuedAt: new Date(), runAfter: new Date(), paymentId: (await ap(js.id, `p-${k}`)).id } });
    }
    // 장애: critical 열림 1, critical이었다 닫힘 1(제외), warning 열림(제외)
    await db.opsEvent.createMany({
      data: [
        { source: "watch", eventId: "e1", kind: "incident_open", key: "health", severity: "critical", message: "응답 없음", occurredAt: new Date(now - 60_000) },
        { source: "watch", eventId: "e2", kind: "incident_open", key: "db", severity: "critical", message: "DB", occurredAt: new Date(now - 50_000) },
        { source: "watch", eventId: "e3", kind: "incident_close", key: "db", severity: "info", message: "복구", occurredAt: new Date(now - 40_000) },
        { source: "watch", eventId: "e4", kind: "incident_open", key: "cert", severity: "warning", message: "인증서", occurredAt: new Date(now - 30_000) },
      ],
    });

    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const body = await (await get(await adminCookie(role))).json();
      expect(counts(body)).toEqual({ signupPending: 2, paymentFailed: 1, refundRequested: 1, inquiryOpen: 2, pgError: 2, automationFailed: 2, incidentCritical: 1, platformInfoMissing: 1 });
      expect(body.total).toBe(12);
    }
  });

  it("플랫폼 정보 7칸이 모두 차면 「플랫폼 정보 미입력」은 0, 하나라도 비면 1", async () => {
    const full = { name: "온큐", representative: "박", businessNumber: "123-45-67890", mailOrderNumber: "2026-서울-1", address: "서울", phone: "1588-0000", email: "a@b.kr" };
    await db.platformBusinessInfo.upsert({ where: { id: 1 }, create: { id: 1, ...full }, update: full });
    const cookie = await adminCookie();
    expect(counts(await (await get(cookie)).json()).platformInfoMissing).toBe(0);
    await db.platformBusinessInfo.update({ where: { id: 1 }, data: { email: "" } });
    expect(counts(await (await get(cookie)).json()).platformInfoMissing).toBe(1);
    await db.platformBusinessInfo.update({ where: { id: 1 }, data: { ...Object.fromEntries(Object.keys(full).map((k) => [k, ""])) } });
  });

  it("비로그인과 파트너스 로그인은 401", async () => {
    expect((await get("")).status).toBe(401);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get(`lo_seller=${login.token}`)).status).toBe(401);
  });
});
