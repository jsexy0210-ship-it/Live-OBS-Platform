import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { getSellerMember, listSellerMembers } from "../../lib/server/buyers/sellerMembers";
import type { TenantContext } from "../../lib/server/tenant/context";

const ctx: TenantContext = { sellerId: "seller-a", actorType: "SELLER_USER", actorId: "staff", isOwner: false, permissions: ["MEMBER_POINTS"], readOnly: false };
const memberId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const member = (n: number) => ({ id: memberId(n), broadcastNickname: `회원 ${n}`, name: "비공개", phone: "01000000000", grade: null, status: "ACTIVE", marketingConsentAt: null, createdAt: new Date("2026-10-01T00:00:00Z"), lastLoginAt: null });
type Scope = { sellerId: string; buyerMemberId: { in: string[] } | string; legalHoldAt: null; paidAt?: { not: null } };
function fixture(size = 3) {
  const rows = Array.from({ length: size }, (_, i) => member(i + 1));
  const orders = [
    { sellerId: ctx.sellerId, buyerMemberId: memberId(1), legalHoldAt: null, paidAt: new Date(), totalAmount: 30000, refundAmount: null },
    { sellerId: ctx.sellerId, buyerMemberId: memberId(1), legalHoldAt: null, paidAt: new Date(), totalAmount: 10000, refundAmount: 7000 },
    { sellerId: ctx.sellerId, buyerMemberId: memberId(1), legalHoldAt: null, paidAt: null, totalAmount: 5000, refundAmount: null },
    { sellerId: ctx.sellerId, buyerMemberId: memberId(1), legalHoldAt: new Date(), paidAt: new Date(), totalAmount: 99999, refundAmount: null },
    { sellerId: "seller-b", buyerMemberId: memberId(1), legalHoldAt: null, paidAt: new Date(), totalAmount: 88888, refundAmount: null },
    { sellerId: ctx.sellerId, buyerMemberId: memberId(3), legalHoldAt: null, paidAt: new Date(), totalAmount: 77777, refundAmount: null },
  ];
  const matching = (where: Scope) => orders.filter((o) => o.sellerId === where.sellerId && (typeof where.buyerMemberId === "string" ? o.buyerMemberId === where.buyerMemberId : where.buyerMemberId.in.includes(o.buyerMemberId)) && o.legalHoldAt === where.legalHoldAt && (!where.paidAt || o.paidAt !== null));
  const aggregate = (selected: typeof orders) => ({ _sum: { totalAmount: selected.reduce((sum, o) => sum + o.totalAmount, 0), refundAmount: selected.reduce((sum, o) => sum + (o.refundAmount ?? 0), 0) } });
  const order = {
    groupBy: vi.fn(async ({ where, _count }: { where: Scope; _count?: unknown }) => {
      const selected = matching(where);
      return [...new Set(selected.map((o) => o.buyerMemberId))].map((id) => ({ buyerMemberId: id, ...(_count ? { _count: { _all: selected.filter((o) => o.buyerMemberId === id).length } } : aggregate(selected.filter((o) => o.buyerMemberId === id))) }));
    }),
    count: vi.fn(async ({ where }: { where: Scope }) => matching(where).length),
    aggregate: vi.fn(async ({ where }: { where: Scope }) => aggregate(matching(where))),
  };
  const rewardBalance = {
    findMany: vi.fn(async () => [{ buyerMemberId: memberId(1), balance: 1500 }]),
    findUnique: vi.fn(async () => ({ balance: 1500 })),
  };
  const buyerMember = { findMany: vi.fn(async () => rows), findFirst: vi.fn(async () => rows[0]) };
  return { db: { buyerMember, order, rewardBalance } as unknown as PrismaClient, buyerMember, order, rewardBalance };
}

describe("SA041 현재 페이지의 상세와 같은 읽기 집계", () => {
  it("테넌트·분리 보관·결제 시각·환불을 상세와 같게 적용하고 다음 쪽은 집계하지 않는다", async () => {
    const f = fixture();
    const r = await listSellerMembers(f.db, ctx, { limit: "2" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("list failed");
    expect(r.members).toHaveLength(2);
    expect(r.nextCursor).not.toBeNull();
    expect(r.members[0]).toMatchObject({ orderCount: 3, totalPaid: 33000, rewardBalance: 1500 });
    expect(r.members[1]).toMatchObject({ orderCount: 0, totalPaid: 0, rewardBalance: 0 });
    expect(r.members[0]).not.toHaveProperty("name");
    expect(r.members[0]).not.toHaveProperty("phone");
    expect(f.order.groupBy).toHaveBeenNthCalledWith(1, { by: ["buyerMemberId"], where: { sellerId: ctx.sellerId, buyerMemberId: { in: [memberId(1), memberId(2)] }, legalHoldAt: null }, _count: { _all: true } });
    expect(f.order.groupBy.mock.calls[1][0]).toMatchObject({ where: { paidAt: { not: null } }, _sum: { totalAmount: true, refundAmount: true } });
    expect(f.rewardBalance.findMany).toHaveBeenCalledWith({ where: { sellerId: ctx.sellerId, buyerMemberId: { in: [memberId(1), memberId(2)] } }, select: { buyerMemberId: true, balance: true } });
    expect(f.order.count).not.toHaveBeenCalled();
    expect(f.order.aggregate).not.toHaveBeenCalled();
    expect(f.rewardBalance.findUnique).not.toHaveBeenCalled();
    const detail = await getSellerMember(f.db, ctx, memberId(1));
    expect(r.members[0]).toEqual(detail);
  });

  it.each([1, 10])("%i명도 집계 조회는 세 번으로 일정하다", async (size) => {
    const f = fixture(size);
    await listSellerMembers(f.db, ctx, {});
    expect(f.order.groupBy).toHaveBeenCalledTimes(2);
    expect(f.rewardBalance.findMany).toHaveBeenCalledTimes(1);
    expect(f.order.count).not.toHaveBeenCalled();
    expect(f.rewardBalance.findUnique).not.toHaveBeenCalled();
  });

  it("빈 목록은 집계 조회 없이 빈 결과를 유지한다", async () => {
    const f = fixture(0);
    expect(await listSellerMembers(f.db, ctx, {})).toEqual({ ok: true, members: [], nextCursor: null });
    expect(f.order.groupBy).not.toHaveBeenCalled();
    expect(f.rewardBalance.findMany).not.toHaveBeenCalled();
  });

  it("기존 회원 조회 권한이 없으면 어떤 조회도 실행하지 않는다", async () => {
    const f = fixture();
    await expect(listSellerMembers(f.db, { ...ctx, permissions: [] }, {})).rejects.toMatchObject({ status: 403 });
    expect(f.buyerMember.findMany).not.toHaveBeenCalled();
    expect(f.order.groupBy).not.toHaveBeenCalled();
    expect(f.rewardBalance.findMany).not.toHaveBeenCalled();
  });
});
