import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listPendingDeposits } from "../../lib/server/payments/bank";
import type { TenantContext } from "../../lib/server/tenant/context";

const now = new Date("2026-10-06T00:30:00Z");
const ctx: TenantContext = { sellerId: "seller-a", actorType: "SELLER_USER", actorId: "owner", isOwner: true, permissions: [], readOnly: false };
function fixture() {
  const rows = [
    { id: "pending", status: "PENDING_PAYMENT", paymentDueAt: new Date(now.getTime() + 1000), paidAt: null, autoCancelledAt: null },
    { id: "overdue", status: "PENDING_PAYMENT", paymentDueAt: now, paidAt: null, autoCancelledAt: null },
    { id: "paid", status: "PAID", paymentDueAt: null, paidAt: now, autoCancelledAt: null },
    { id: "cancelled", status: "CANCELLED", paymentDueAt: now, paidAt: null, autoCancelledAt: now },
  ].map((row, i) => ({ ...row, orderNo: i + 1, totalAmount: 1000, broadcastNicknameSnapshot: "닉네임", paymentMethod: "BANK_TRANSFER", createdAt: now, buyerMember: { name: "입금자" } }));
  const order = { count: vi.fn().mockResolvedValue(4), findMany: vi.fn().mockResolvedValue(rows), aggregate: vi.fn().mockResolvedValue({ _count: 1, _sum: { totalAmount: 1000 } }) };
  const auditLog = { create: vi.fn().mockResolvedValue({ id: "audit" }) };
  return { db: { order, auditLog } as unknown as PrismaClient, order, auditLog };
}

describe("SA026 읽기 계약", () => {
  it.each([
    { from: "2026-02-30" }, { to: "2026-13-01" }, { from: "2026-10-07", to: "2026-10-06" },
    { status: "CANCELLED" }, { status: "ALL,PAID" }, { searchBy: "phone" }, { q: "bad\u0000" },
    { searchBy: "amount", q: "1.5" }, { searchBy: "amount", q: "2147483648" },
    { offset: "-1" }, { offset: "100001" }, { limit: "0" }, { limit: "51" },
  ])("잘못된 필터는 DB 조회 전 거부한다: %j", async (query) => {
    const f = fixture();
    expect(await listPendingDeposits(f.db, ctx, query, now)).toEqual({ ok: false });
    expect(f.order.findMany).not.toHaveBeenCalled();
    expect(f.order.count).not.toHaveBeenCalled();
  });
  it("KST 시작일과 종료일 전체를 포함하며 판매자/분리보관 경계를 유지한다", async () => {
    const f = fixture();
    await listPendingDeposits(f.db, ctx, { from: "2026-10-06", to: "2026-10-06", status: "ALL", offset: "100000", limit: "50" }, now);
    expect(f.order.findMany.mock.calls[0][0]).toMatchObject({ skip: 100000, take: 50, where: {
      sellerId: ctx.sellerId, legalHoldAt: null, createdAt: { gte: new Date("2026-10-05T15:00:00Z"), lt: new Date("2026-10-06T15:00:00Z") },
    } });
    for (const [call] of f.order.count.mock.calls) expect(call.where).toMatchObject({ sellerId: ctx.sellerId, legalHoldAt: null });
    expect(f.order.count.mock.calls[2][0].where.paidAt).toEqual({ gte: new Date("2026-10-05T15:00:00Z"), lt: new Date("2026-10-06T15:00:00Z") });
  });
  it("생략한 상태는 기존 대기 필터이고 표시 상태/요약만 추가된다", async () => {
    const f = fixture();
    const result = await listPendingDeposits(f.db, ctx, {}, now);
    expect(f.order.findMany.mock.calls[0][0].where.AND[0]).toMatchObject({ status: "PENDING_PAYMENT", payments: { none: { status: { in: ["APPROVING", "PAID", "PARTIAL_CANCELLED"] } } } });
    expect(result.ok && result.value.deposits.map((d) => d.depositStatus)).toEqual(["PENDING_PAYMENT", "OVERDUE", "PAID", "AUTO_CANCELLED"]);
    expect(result.ok && result.value.summary).toMatchObject({ pendingCount: 1, pendingAmount: 1000, confirmedTodayCount: 4 });
  });
  it("복수 상태와 검색어를 정규화하고 요약에는 목록 검색을 적용하지 않는다", async () => {
    const f = fixture();
    await listPendingDeposits(f.db, ctx, { status: "OVERDUE,PAID", q: " １２，０００원 ", searchBy: "amount" }, now);
    const where = f.order.findMany.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual({ totalAmount: 12000 });
    expect(where.AND[0].OR).toHaveLength(2);
    expect(f.order.aggregate.mock.calls[0][0].where).not.toHaveProperty("totalAmount");
    await listPendingDeposits(f.db, ctx, { q: "  ＡBC  ", searchBy: "buyer" }, now);
    expect(f.order.findMany.mock.calls[1][0].where.AND[1]).toEqual({ broadcastNicknameSnapshot: { contains: "ABC", mode: "insensitive" } });
  });
  it("PII 권한 없는 직원은 이름 검색/반환/선택을 못 하고 닉네임 검색은 가능하다", async () => {
    const f = fixture();
    const staff: TenantContext = { ...ctx, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    await expect(listPendingDeposits(f.db, staff, { q: "입금자", searchBy: "depositor" }, now)).rejects.toMatchObject({ status: 403 });
    expect(f.order.findMany).not.toHaveBeenCalled();
    const result = await listPendingDeposits(f.db, staff, { q: "닉" }, now);
    expect(f.order.findMany.mock.calls[0][0].select).not.toHaveProperty("buyerMember");
    expect(result.ok && result.value.deposits[0]).not.toHaveProperty("depositorName");
    expect(f.auditLog.create).not.toHaveBeenCalled();
  });
  it("주문 권한이 없는 직원은 집계도 조회하지 못한다", async () => {
    const f = fixture();
    await expect(listPendingDeposits(f.db, { ...ctx, isOwner: false }, {}, now)).rejects.toMatchObject({ status: 403 });
    expect(f.order.count).not.toHaveBeenCalled();
  });
  it("입금자명 검색은 PII 로그를 남긴다", async () => {
    const f = fixture();
    await listPendingDeposits(f.db, ctx, { q: "입금자", searchBy: "depositor" }, now);
    expect(f.order.findMany.mock.calls[0][0].where.AND[1]).toEqual({ buyerMember: { name: { contains: "입금자", mode: "insensitive" } } });
    expect(f.auditLog.create.mock.calls[0][0].data.action).toBe("customer.pii.view");
  });
});
