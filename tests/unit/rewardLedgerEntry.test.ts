import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { TenantContext } from "../../lib/server/tenant/context";
import { getRewardLedgerEntry } from "../../lib/server/seller-settings/rewardLedger";

const sellerId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
const ctx: TenantContext = { sellerId, actorType: "SELLER_USER", actorId: "33333333-3333-4333-8333-333333333333", isOwner: true, permissions: [], readOnly: false };
function database() {
  const findFirst = vi.fn(async () => ({ id, type: "REVOKE", amount: -1350, status: "FAILED", testMode: false, failureReason: "insufficient", reason: null, idempotencyKey: "private-operation", createdAt: new Date("2026-10-19T00:00:00Z"), processedAt: null, buyerMember: { id, broadcastNickname: "소유 원장" }, order: null }));
  const query = vi.fn(async () => []);
  return { db: { rewardLedger: { findFirst }, $queryRaw: query } as unknown as PrismaClient, findFirst, query };
}
describe("원장 단건 읽기 경계", () => {
  it("현재 쇼핑몰의 정확 ID만 조회하고 내부 멱등 키를 DTO에 내보내지 않는다", async () => {
    const { db, findFirst, query } = database();
    const entry = await getRewardLedgerEntry(db, ctx, id);
    expect(findFirst).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ where: { sellerId, id } }));
    expect(entry).toMatchObject({ id, amount: -1350, kind: "REVOKE", balanceAfter: null });
    expect(entry).not.toHaveProperty("idempotencyKey");
    expect(query).not.toHaveBeenCalled();
  });
  it("권한 없는 직원은 데이터 질의 전에 거절한다", async () => {
    const { db, findFirst } = database();
    await expect(getRewardLedgerEntry(db, { ...ctx, isOwner: false, permissions: [] }, id)).rejects.toMatchObject({ status: 403 });
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("잘못된 식별자는 데이터 질의 없이 없는 대상으로 처리한다", async () => {
    const { db, findFirst } = database();
    expect(await getRewardLedgerEntry(db, ctx, "invalid")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
