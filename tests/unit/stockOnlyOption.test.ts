import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { adjustStock } from "../../lib/server/products/stock";
import type { TenantContext } from "../../lib/server/tenant/context";

const sellerId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const optionId = "00000000-0000-4000-8000-000000000003";
const replacementId = "00000000-0000-4000-8000-000000000004";
const ctx: TenantContext = { sellerId, actorType: "SELLER_USER", actorId: sellerId, isOwner: true, permissions: [], readOnly: false };

function fixture(ids: string[]) {
  const tx = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [{ id: productId }]),
    productOption: {
      findMany: vi.fn(async () => ids.map((id) => ({ id }))),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(),
    },
    stockMovement: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const db = { $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } as unknown as PrismaClient;
  return { db, tx };
}

describe("기본 옵션 재고 반영 경계", () => {
  it.each([{ ids: [] }, { ids: [optionId, replacementId] }, { ids: [replacementId] }])("활성 옵션 $ids는 상품 잠금 뒤 거절하며 재고·원장·감사를 쓰지 않는다", async ({ ids }) => {
    const { db, tx } = fixture(ids);
    expect(await adjustStock(db, ctx, productId, optionId, { delta: 5, reason: "재고 일괄 수정" }, optionId)).toEqual({ ok: false, reason: "stock_conflict" });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0].join("?")).toContain('FROM "Product"');
    expect(tx.$queryRaw.mock.calls[0][0].join("?")).toContain("FOR UPDATE");
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.productOption.findMany.mock.invocationCallOrder[0]);
    expect(tx.productOption.findMany).toHaveBeenCalledWith({ where: { sellerId, productId, deletedAt: null }, select: { id: true } });
    expect(tx.productOption.findFirst).not.toHaveBeenCalled();
    expect(tx.productOption.updateMany).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("원 ID가 단일 활성 옵션이면 기존 재고 조회로 이어진다", async () => {
    const { db, tx } = fixture([optionId]);
    await expect(adjustStock(db, ctx, productId, optionId, { delta: 5, reason: "재고 일괄 수정" }, optionId)).rejects.toMatchObject({ status: 404 });
    expect(tx.productOption.findFirst).toHaveBeenCalledTimes(1);
  });

  it("선택 인수가 없는 기존 호출은 추가 잠금·단일 옵션 검사를 하지 않는다", async () => {
    const { db, tx } = fixture([optionId, replacementId]);
    await expect(adjustStock(db, ctx, productId, optionId, { delta: 5, reason: "재고 일괄 수정" })).rejects.toMatchObject({ status: 404 });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.productOption.findMany).not.toHaveBeenCalled();
    expect(tx.productOption.findFirst).toHaveBeenCalledTimes(1);
  });
});
