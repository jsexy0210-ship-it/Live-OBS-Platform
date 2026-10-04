import type { PrismaClient, ProductStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { PRODUCT_STATUSES } from "./manage";

// 상품 목록에서 고른 상품 일괄 처리(PRODUCT_MANAGE). 상태 바꾸기(노출 끄기=DRAFT, 숨김=HIDDEN 등 네 상태)와 삭제(소프트 삭제).
// 한 번에 1~200개. 고른 상품을 한 트랜잭션에서 잠그고 바꾼다. 상품마다 로그 추적(product.update·product.delete, bulk: true)을 남긴다.
// 다른 판매자 상품·이미 지운 상품·없는 id는 바꾸지 않고 skipped에 not_found로 돌려준다(다른 판매자 상품이 있는지 알리지 않음).
// 판매 중(ON_SALE)으로 바꿀 때 살아 있는 옵션이 없는 상품은 no_sellable_option으로 건너뛴다. 이미 같은 상태면 바꾼 것으로 보고 로그는 남기지 않는다.
export const MAX_BULK_PRODUCTS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BulkSkip = { productId: string; reason: "not_found" | "no_sellable_option" };
export type BulkResult = { ok: true; value: { updated: string[]; skipped: BulkSkip[] } } | { ok: false; reason: "invalid_bulk" };

function parse(raw: unknown): { ids: string[]; action: "delete" } | { ids: string[]; action: "status"; status: ProductStatus } | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.productIds) || b.productIds.length < 1 || b.productIds.length > MAX_BULK_PRODUCTS) return null;
  if (!b.productIds.every((id): id is string => typeof id === "string" && UUID.test(id))) return null;
  const ids = [...new Set(b.productIds.map((id) => id.toLowerCase()))];
  if (b.action === "delete" && b.status === undefined) return { ids, action: "delete" };
  if (b.action === "status" && PRODUCT_STATUSES.includes(b.status as ProductStatus)) return { ids, action: "status", status: b.status as ProductStatus };
  return null;
}

export async function bulkProducts(db: PrismaClient, ctx: TenantContext, raw: unknown): Promise<BulkResult> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const req = parse(raw);
  if (!req) return { ok: false, reason: "invalid_bulk" };
  return db.$transaction(async (tx) => {
    // id 순으로 잠가 다른 일괄 처리·단건 변경과 교착되지 않게 한다
    const locked = await tx.$queryRaw<{ id: string; status: ProductStatus }[]>`
      SELECT "id", "status"::text AS "status" FROM "Product"
      WHERE "id" = ANY(${req.ids}::uuid[]) AND "sellerId" = ${ctx.sellerId}::uuid AND "deletedAt" IS NULL
      ORDER BY "id" FOR UPDATE`;
    const byId = new Map(locked.map((r) => [r.id, r]));
    const skipped: BulkSkip[] = req.ids.filter((id) => !byId.has(id)).map((productId) => ({ productId, reason: "not_found" }));
    const updated: string[] = [];
    const now = await dbNow(tx);
    const audit = { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, targetType: "Product" } as const;
    if (req.action === "delete") {
      const ids = locked.map((r) => r.id);
      if (ids.length) await tx.product.updateMany({ where: { id: { in: ids }, sellerId: ctx.sellerId }, data: { deletedAt: now } });
      for (const id of ids) await writeAudit(tx, { ...audit, action: "product.delete", targetId: id, after: { bulk: true } });
      updated.push(...ids);
    } else {
      let targets = locked.filter((r) => r.status !== req.status);
      if (req.status === "ON_SALE" && targets.length) {
        const withOption = await tx.productOption.groupBy({
          by: ["productId"],
          where: { sellerId: ctx.sellerId, productId: { in: targets.map((r) => r.id) }, deletedAt: null },
        });
        const sellable = new Set(withOption.map((r) => r.productId));
        for (const r of targets) if (!sellable.has(r.id)) skipped.push({ productId: r.id, reason: "no_sellable_option" });
        targets = targets.filter((r) => sellable.has(r.id));
      }
      if (targets.length) await tx.product.updateMany({ where: { id: { in: targets.map((r) => r.id) }, sellerId: ctx.sellerId }, data: { status: req.status } });
      for (const r of targets) {
        await writeAudit(tx, { ...audit, action: "product.update", targetId: r.id, before: { status: r.status }, after: { status: req.status, bulk: true } });
      }
      const skippedIds = new Set(skipped.map((s) => s.productId));
      updated.push(...locked.map((r) => r.id).filter((id) => !skippedIds.has(id)));
    }
    // 요청한 순서대로 돌려준다
    const order = new Map(req.ids.map((id, i) => [id, i]));
    updated.sort((a, b) => order.get(a)! - order.get(b)!);
    skipped.sort((a, b) => order.get(a.productId)! - order.get(b.productId)!);
    return { ok: true as const, value: { updated, skipped } };
  });
}
