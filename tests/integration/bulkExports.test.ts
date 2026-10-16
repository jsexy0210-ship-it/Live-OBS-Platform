import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as jobsRoute } from "../../app/api/seller/bulk-io/jobs/route";
import { POST as memberExportRoute } from "../../app/api/seller/bulk-io/members/export/route";
import { GET as orderExportRoute } from "../../app/api/seller/bulk-io/orders/export/route";
import { loginSeller } from "../../lib/server/auth/login";
import { exportMembersCsv, exportOrdersCsv, parseExportPeriod } from "../../lib/server/shop-bulk-io/exports";
import { exportProductsCsv, getBulkJob, listBulkJobs } from "../../lib/server/shop-bulk-io/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-018 내보내기(주문·회원)와 처리 이력의 「누가」(내려받은 사실·사유·처리자)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const lines = (csv: string) => csv.replace(/^﻿/, "").trim().split(/\r?\n/);

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const staffUser = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE", "ORDER_SHIPPING"] });
  const staff: TenantContext = { ...ctx, actorId: staffUser.id, isOwner: false, permissions: ["PRODUCT_MANAGE", "ORDER_SHIPPING"] };
  const member = async (nick: string, name: string, phone: string) =>
    db.buyerMember.update({ where: { id: (await createBuyer(seller.id, grade.id)).id }, data: { broadcastNickname: nick, name, phone } });
  const order = async (buyerId: string, nick: string, o: { no: number; status?: "PAID" | "PENDING_PAYMENT" | "REFUNDED"; legalHold?: boolean; createdAt?: Date }) => {
    const created = await db.order.create({
      data: {
        sellerId: seller.id,
        orderNo: o.no,
        buyerMemberId: buyerId,
        broadcastNicknameSnapshot: nick,
        totalAmount: 10000,
        status: o.status ?? "PAID",
        paymentMethod: "CARD",
        paidAt: new Date(),
        legalHoldAt: o.legalHold ? new Date() : null,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
    return created;
  };
  return { seller, grade, owner, ctx, staff, staffUser, member, order };
}

describe("주문 내보내기", () => {
  it("기간 안의 주문을 상태·송장·금액과 함께 내보내고(받는 분 정보는 개인정보 권한이 있을 때만), 법정 보관 주문은 뺀다. 이력·로그 추적에 남는다", async () => {
    const s = await shop();
    const m = await s.member("별빛", "홍길동", "01011112222");
    const shipped = await s.order(m.id, "별빛", { no: 1 });
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: shipped.id, courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT", shippedAt: new Date() } });
    await s.order(m.id, "별빛", { no: 2, status: "PENDING_PAYMENT" });
    await s.order(m.id, "별빛", { no: 3, legalHold: true });
    await s.order(m.id, "별빛", { no: 4, createdAt: new Date("2020-01-05T00:00:00Z") });
    await db.orderShippingAddress.create({ data: { sellerId: s.seller.id, orderId: shipped.id, recipientName: "박받는", phone: "01033334444", zipCode: "06236", address1: "서울시 강남구" } });

    const r = await exportOrdersCsv(db, s.ctx, { from: today(), to: today() });
    if (!r.ok) throw new Error(r.reason);
    const rows = lines(r.value.csv);
    expect(rows[0]).toBe("주문번호,주문 시각,닉네임,상품,금액,환불 금액,결제수단,주문 상태,배송 상태,택배사,송장번호,받는 분,연락처,주소");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("결제 완료");
    expect(rows[1]).toContain("배송 중,CJ,123456789012,박받는,01033334444,(06236) 서울시 강남구");
    expect(rows[2]).toContain("입금 대기");
    expect(rows[2]).toContain("발송 전");
    expect(rows[2].endsWith(",,,")).toBe(true);
    expect(r.value.csv).not.toContain("홍길동");
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", targetType: "OrderExport", actorId: s.owner.id } })).toBe(1);
    // 개인정보 권한이 없는 직원(ORDER_SHIPPING만)은 받는 분 열이 없다
    const noPii = await exportOrdersCsv(db, s.staff, { from: today(), to: today() });
    if (!noPii.ok) throw new Error(noPii.reason);
    expect(lines(noPii.value.csv)[0]).toBe("주문번호,주문 시각,닉네임,상품,금액,환불 금액,결제수단,주문 상태,배송 상태,택배사,송장번호");
    expect(noPii.value.csv).not.toContain("박받는");
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", targetType: "OrderExport", actorId: s.staffUser.id } })).toBe(0);
    // 환불 금액: 금액이 비어 있는 옛 전액 환불 주문은 주문 금액으로
    await s.order(m.id, "별빛", { no: 5, status: "REFUNDED" });
    const refunded = await exportOrdersCsv(db, s.ctx, { from: today(), to: today() });
    expect(refunded.ok && lines(refunded.value.csv).find((l) => l.includes("환불,"))).toContain(",10000,10000,카드,환불,");
    const old = await exportOrdersCsv(db, s.ctx, { from: "2020-01-01", to: "2020-01-31" });
    expect(old.ok && lines(old.value.csv)).toHaveLength(2);
    expect(old.ok && old.value.csv).toContain(",,,");

    const job = (await listBulkJobs(db, s.ctx, { all: true })).jobs.find((j) => j.kind === "ORDER_EXPORT");
    expect(job).toMatchObject({ status: "COMMITTED", totalRows: expect.any(Number), undoable: false, actorName: s.owner.name, actorIsOwner: true, meta: { from: "2020-01-01", to: "2020-01-31", includePii: true } });
    expect(await db.auditLog.count({ where: { action: "bulk_io.order_export", actorId: s.owner.id } })).toBeGreaterThanOrEqual(2);
  });

  it("기간은 둘 다 필요하고 366일 이내여야 하며, ORDER_SHIPPING 권한이 없으면 막힌다", async () => {
    const s = await shop();
    expect(await exportOrdersCsv(db, s.ctx, {})).toEqual({ ok: false, reason: "invalid_period" });
    expect(await exportOrdersCsv(db, s.ctx, { from: "2026-10-05", to: "2026-10-01" })).toEqual({ ok: false, reason: "invalid_period" });
    expect(await exportOrdersCsv(db, s.ctx, { from: "2024-01-01", to: "2026-01-01" })).toEqual({ ok: false, reason: "invalid_period" });
    expect(await exportOrdersCsv(db, s.ctx, { from: "2026-13-01", to: "2026-13-02" })).toEqual({ ok: false, reason: "invalid_period" });
    expect(parseExportPeriod("2026-01-01", "2026-12-31")).not.toBeNull();
    const noShip = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    await expect(exportOrdersCsv(db, { ...s.ctx, actorId: noShip.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] }, { from: today(), to: today() })).rejects.toThrow();
    // 다른 쇼핑몰 주문은 섞이지 않는다
    const other = await shop();
    const om = await other.member("남", "남", "01099998888");
    await other.order(om.id, "남", { no: 1 });
    const mine = await exportOrdersCsv(db, s.ctx, { from: today(), to: today() });
    expect(mine.ok && lines(mine.value.csv)).toHaveLength(1);
  });
});

describe("회원 내보내기", () => {
  it("대표자만, 사유 필수. 이름·연락처는 포함을 고를 때만 넣고 로그 추적(사유·개인정보 열람)과 이력에 남는다", async () => {
    const s = await shop();
    const m = await s.member("별빛사냥꾼", "홍길동", "01011112222");
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: m.id, balance: 1500 } });
    await db.buyerMember.update({ where: { id: m.id }, data: { marketingConsentAt: new Date() } });
    const gone = await s.member("탈퇴회원", "탈퇴", "01000000000");
    await db.buyerMember.update({ where: { id: gone.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });

    expect(await exportMembersCsv(db, s.ctx, { reason: "" })).toEqual({ ok: false, reason: "invalid_reason" });
    expect(await exportMembersCsv(db, s.ctx, { reason: "가".repeat(101) })).toEqual({ ok: false, reason: "invalid_reason" });
    expect(await exportMembersCsv(db, s.ctx, { reason: "x", includePii: "yes" })).toEqual({ ok: false, reason: "invalid_reason" });
    await expect(exportMembersCsv(db, s.staff, { reason: "세무 자료" })).rejects.toThrow();
    await expect(exportMembersCsv(db, { ...s.ctx, readOnly: true }, { reason: "세무 자료" })).rejects.toThrow();
    expect(await db.bulkJob.count({ where: { kind: "MEMBER_EXPORT" } })).toBe(0);

    const plain = await exportMembersCsv(db, s.ctx, { reason: "적립금 소멸 안내 발송" });
    if (!plain.ok) throw new Error(plain.reason);
    const pl = lines(plain.value.csv);
    expect(pl[0]).toBe("닉네임,등급,상태,가입일,최근 접속,마케팅 수신 동의,적립금 잔액");
    expect(pl).toHaveLength(2);
    expect(pl[1]).toContain("별빛사냥꾼");
    expect(pl[1]).toContain("정상,");
    expect(pl[1]).toContain("예,1500");
    expect(plain.value.csv).not.toContain("홍길동");
    expect(plain.value.csv).not.toContain("탈퇴회원");
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", targetType: "MemberExport" } })).toBe(0);

    const pii = await exportMembersCsv(db, s.ctx, { reason: "세무 · 회계 자료", includePii: true });
    if (!pii.ok) throw new Error(pii.reason);
    expect(lines(pii.value.csv)[0]).toBe("닉네임,등급,상태,가입일,최근 접속,마케팅 수신 동의,적립금 잔액,이름,연락처");
    expect(pii.value.csv).toContain("홍길동");
    expect(pii.value.csv).toContain("01011112222");
    expect(await db.auditLog.count({ where: { action: "customer.pii.view", targetType: "MemberExport", actorId: s.owner.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "bulk_io.member_export", reason: "세무 · 회계 자료" } })).toBe(1);

    const jobs = (await listBulkJobs(db, s.ctx, { all: true })).jobs.filter((j) => j.kind === "MEMBER_EXPORT");
    expect(jobs.map((j) => [j.reason, j.meta])).toEqual([["세무 · 회계 자료", { includePii: true }], ["적립금 소멸 안내 발송", { includePii: false }]]);
    expect(jobs[0]).toMatchObject({ actorName: s.owner.name, actorIsOwner: true });
  });
});

describe("처리 이력", () => {
  it("기본 목록은 일괄 등록만(기존 화면 그대로), all=true는 내보내기까지, 처리한 직원 이름과 대표자 여부를 준다", async () => {
    const s = await shop();
    await db.bulkJob.create({ data: { sellerId: s.seller.id, kind: "PRODUCT_IMPORT", status: "COMMITTED", totalRows: 3, productCount: 3, actorType: "SELLER_USER", actorId: s.staffUser.id, committedAt: new Date() } });
    const exp = await exportProductsCsv(db, s.staff);
    expect(exp.ok).toBe(true);
    const base = await listBulkJobs(db, s.ctx);
    expect(base.jobs.map((j) => j.kind)).toEqual(["PRODUCT_IMPORT"]);
    expect(base.jobs[0]).toMatchObject({ actorName: s.staffUser.name, actorIsOwner: false });
    const all = await listBulkJobs(db, s.ctx, { all: true });
    expect(all.jobs.map((j) => j.kind).sort()).toEqual(["PRODUCT_EXPORT", "PRODUCT_IMPORT"]);
    const pe = all.jobs.find((j) => j.kind === "PRODUCT_EXPORT")!;
    expect(pe).toMatchObject({ actorName: s.staffUser.name, actorIsOwner: false, undoable: false, reason: null });
    expect(await getBulkJob(db, s.ctx, pe.id)).toMatchObject({ kind: "PRODUCT_EXPORT", actorName: s.staffUser.name });
    // 마스터 대리 조회처럼 직원이 아닌 행위자는 이름이 없다
    await db.bulkJob.create({ data: { sellerId: s.seller.id, kind: "ORDER_EXPORT", status: "COMMITTED", totalRows: 0, productCount: 0, actorType: "PLATFORM_ADMIN", actorId: null, committedAt: new Date() } });
    expect((await listBulkJobs(db, s.ctx, { all: true })).jobs.find((j) => j.kind === "ORDER_EXPORT")).toMatchObject({ actorName: null, actorIsOwner: null });
    // 다른 쇼핑몰 이력은 섞이지 않는다
    const other = await shop();
    expect((await listBulkJobs(db, other.ctx, { all: true })).jobs).toEqual([]);
  });
});

describe("경로", () => {
  it("주문 내보내기 GET(기간 400), 회원 내보내기 POST(사유 400·직원 403), 처리 이력 ?all=true", async () => {
    const s = await shop();
    const login = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const owner = await login(s.owner.email);
    const staff = await login(s.staffUser.email);
    const get = (route: (r: Request) => Promise<Response>, path: string, cookie: string) => route(new Request(`http://localhost:3000/api/seller/${path}`, { headers: { ...H, cookie } }));
    const post = (route: (r: Request) => Promise<Response>, path: string, cookie: string, body: unknown) => route(new Request(`http://localhost:3000/api/seller/${path}`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));

    const bad = await get(orderExportRoute, "bulk-io/orders/export?from=2026-10-01", owner);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_period");
    const ok = await get(orderExportRoute, `bulk-io/orders/export?from=${today()}&to=${today()}`, owner);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/csv");
    expect(ok.headers.get("content-disposition")).toContain("orders-");

    const noReason = await post(memberExportRoute, "bulk-io/members/export", owner, { reason: " " });
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toMatchObject({ error: "invalid_reason" });
    expect((await post(memberExportRoute, "bulk-io/members/export", staff, { reason: "세무" })).status).toBe(403);
    const good = await post(memberExportRoute, "bulk-io/members/export", owner, { reason: "세무 · 회계 자료", includePii: true });
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toContain("text/csv");

    const jobs = await (await get(jobsRoute, "bulk-io/jobs?all=true", owner)).json();
    expect(jobs.jobs.map((j: { kind: string }) => j.kind).sort()).toEqual(["MEMBER_EXPORT", "ORDER_EXPORT"]);
    expect((await (await get(jobsRoute, "bulk-io/jobs", owner)).json()).jobs).toEqual([]);
  });
});
