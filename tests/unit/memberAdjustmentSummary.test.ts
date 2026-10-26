import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { TenantContext } from "../../lib/server/tenant/context";
import { getSellerMemberSummary } from "../../lib/server/buyers/sellerMembers";

const sellerId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const ctx: TenantContext = { sellerId, actorType: "SELLER_USER", actorId: "33333333-3333-4333-8333-333333333333", isOwner: true, permissions: ["CUSTOMER_PII_VIEW"], readOnly: false };
function database() {
  const findFirst = vi.fn(async () => ({ id, broadcastNickname: "조정 대상" }));
  const findUnique = vi.fn(async () => ({ balance: 700 }));
  const forbidden = vi.fn(() => { throw new Error("unexpected_private_read"); });
  return { db: { buyerMember: { findFirst }, rewardBalance: { findUnique }, order: { count: forbidden, aggregate: forbidden }, auditLog: { create: forbidden } } as unknown as PrismaClient, findFirst, findUnique, forbidden };
}

describe("적립금 조정 대상 요약", () => {
  it("개인정보 권한과 무관하게 최소 SELECT와 기존 잔액만 조회한다", async () => {
    const { db, findFirst, findUnique, forbidden } = database();
    expect(await getSellerMemberSummary(db, ctx, id)).toEqual({ id, broadcastNickname: "조정 대상", rewardBalance: 700 });
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({ where: { id, sellerId, deletedAt: null }, select: { id: true, broadcastNickname: true } });
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId: id } }, select: { balance: true } });
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("잔액 행이 없으면 기존 상세와 같이 0이고 없는 회원은 잔액도 읽지 않는다", async () => {
    const { db, findFirst, findUnique } = database();
    findUnique.mockResolvedValueOnce(null as never);
    expect((await getSellerMemberSummary(db, ctx, id)).rewardBalance).toBe(0);
    findFirst.mockResolvedValueOnce(null as never);
    await expect(getSellerMemberSummary(db, ctx, id)).rejects.toMatchObject({ status: 404 });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
  it("권한 없는 직원과 잘못된 식별자는 데이터 질의 전에 거절한다", async () => {
    const { db, findFirst, findUnique } = database();
    await expect(getSellerMemberSummary(db, { ...ctx, isOwner: false, permissions: [] }, id)).rejects.toMatchObject({ status: 403 });
    await expect(getSellerMemberSummary(db, ctx, "invalid")).rejects.toMatchObject({ status: 404 });
    expect(findFirst).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
