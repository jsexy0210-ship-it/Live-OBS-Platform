import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { TenantContext } from "../../lib/server/tenant/context";
import { getPrepareOrderSummaries } from "../../lib/server/orders/read";

const sellerId = "11111111-1111-4111-8111-111111111111";
const ids = Array.from({ length: 101 }, (_, n) => `a2222222-2222-4222-8222-${String(n).padStart(12, "0")}`);
const ctx: TenantContext = { sellerId, actorType: "SELLER_USER", actorId: "33333333-3333-4333-8333-333333333333", isOwner: true, permissions: ["CUSTOMER_PII_VIEW"], readOnly: false };
const row = (id: string) => ({ id, orderNo: 7, createdAt: new Date("2026-10-20T23:00:00Z"), shippingPreparedAt: null, buyerMember: { broadcastNickname: "검토 대상" } });
function database(rows = [row(ids[0])]) {
  const findMany = vi.fn(async () => rows);
  const forbidden = vi.fn(() => { throw new Error("unexpected_private_read"); });
  return { db: { order: { findMany, findFirst: forbidden }, auditLog: { create: forbidden } } as unknown as PrismaClient, findMany, forbidden };
}

describe("선택 배송 준비 최소 조회", () => {
  it("100개를 한 번만 조회하고 요청 순서와 네 필드만 유지한다", async () => {
    const selected = ids.slice(0, 100);
    const { db, findMany, forbidden } = database([...selected].reverse().map(row));
    const result = await getPrepareOrderSummaries(db, ctx, [...selected, selected[0].toUpperCase()].join(","));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("invalid_result");
    expect(result.orders.map((order) => order.id)).toEqual(selected);
    expect(result.orders[0]).toEqual({ id: selected[0], orderNoLabel: "20261021-0007", buyer: { broadcastNickname: "검토 대상" }, shippingPreparedAt: null });
    expect(result.missing).toBe(0);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({ where: { sellerId, legalHoldAt: null, id: { in: selected } }, select: { id: true, orderNo: true, createdAt: true, shippingPreparedAt: true, buyerMember: { select: { broadcastNickname: true } } } });
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("없는 대상만 제외하고 모두 없으면 빈 결과와 원 대상 수를 준다", async () => {
    const { db, findMany } = database();
    const partial = await getPrepareOrderSummaries(db, ctx, ids.slice(0, 2).join(","));
    expect(partial).toMatchObject({ ok: true, orders: [{ id: ids[0] }], missing: 1 });
    findMany.mockResolvedValueOnce([]);
    expect(await getPrepareOrderSummaries(db, ctx, ids.slice(0, 2).join(","))).toEqual({ ok: true, orders: [], missing: 2 });
  });
  it("101개·잘못된 UUID·빈 대상과 권한 없는 직원은 조회하지 않는다", async () => {
    const { db, findMany } = database();
    for (const raw of [ids.join(","), "invalid", "", null]) expect(await getPrepareOrderSummaries(db, ctx, raw)).toEqual({ ok: false });
    await expect(getPrepareOrderSummaries(db, { ...ctx, isOwner: false, permissions: [] }, ids[0])).rejects.toMatchObject({ status: 403 });
    expect(findMany).not.toHaveBeenCalled();
  });
  it("데이터 조회 오류는 빈 성공이나 부분 성공으로 바꾸지 않는다", async () => {
    const { db, findMany } = database();
    const failure = new Error("owned_read_failed");
    findMany.mockRejectedValueOnce(failure);
    await expect(getPrepareOrderSummaries(db, ctx, ids[0])).rejects.toBe(failure);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
