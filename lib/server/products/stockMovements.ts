import type { ActorType, Prisma, PrismaClient, StockMovementReason } from "@prisma/client";
import { notFound } from "../authz/errors";
import { requireSellerRead, type TenantContext } from "../tenant/context";

// 재고 이력 조회(화면 SA-014 재고 관리, PRODUCT_MANAGE). 판매자 범위 안만 보이고, 다른 쇼핑몰 상품·옵션은 404.
// 최근순(createdAt·id 내림차순) keyset 커서. 커서는 마지막 항목의 「시각|id」를 base64url로 감싼 값이다.

export const DEFAULT_MOVEMENT_PAGE = 50;
export const MAX_MOVEMENT_PAGE = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 화면에 보여 줄 유형 이름
export const STOCK_MOVEMENT_TYPE_LABELS: Record<StockMovementReason, string> = {
  ORDER: "주문",
  CANCEL: "취소",
  REFUND: "환불",
  MANUAL: "직접 변경",
};

// 처리자 이름(직원이 아닌 경우). 직원은 직원 이름을 쓴다.
const ACTOR_LABELS: Record<Exclude<ActorType, "SELLER_USER">, string> = {
  BUYER: "구매자 주문",
  SYSTEM: "자동 처리",
  PLATFORM_ADMIN: "플랫폼 관리자",
};

const encodeCursor = (createdAt: Date, id: string) => Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");

function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  const [at, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const createdAt = new Date(at ?? "");
  if (rest.length || !id || !UUID.test(id) || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== at) return null;
  return { createdAt, id };
}

export async function listStockMovements(
  db: PrismaClient,
  ctx: TenantContext,
  q: { productId?: string | null; optionId?: string | null; cursor?: string | null; limit?: string | null },
) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const limit = q.limit == null || q.limit === "" ? DEFAULT_MOVEMENT_PAGE : /^\d+$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MOVEMENT_PAGE) return { ok: false as const, reason: "invalid_limit" as const };
  let after: Prisma.StockMovementWhereInput = {};
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) return { ok: false as const, reason: "invalid_cursor" as const };
    after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  // 상품·옵션을 정하면 이 판매자 것인지 먼저 본다(지운 상품·옵션의 이력도 볼 수 있다). 다른 쇼핑몰 것은 없는 것과 같다.
  const scope: Prisma.StockMovementWhereInput = { sellerId: ctx.sellerId };
  if (q.productId) {
    if (!UUID.test(q.productId) || !(await db.product.findFirst({ where: { id: q.productId, sellerId: ctx.sellerId }, select: { id: true } }))) throw notFound();
    scope.option = { productId: q.productId };
  }
  if (q.optionId) {
    const option = UUID.test(q.optionId)
      ? await db.productOption.findFirst({ where: { id: q.optionId, sellerId: ctx.sellerId, ...(q.productId ? { productId: q.productId } : {}) }, select: { id: true } })
      : null;
    if (!option) throw notFound();
    scope.optionId = q.optionId;
  }
  const rows = await db.stockMovement.findMany({
    where: { ...scope, ...after },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { option: { select: { name: true, productId: true, product: { select: { name: true } } } } },
  });
  const page = rows.slice(0, limit);
  const staffIds = [...new Set(page.filter((m) => m.actorType === "SELLER_USER" && m.actorId).map((m) => m.actorId!))];
  const staff = staffIds.length
    ? await db.sellerUser.findMany({ where: { sellerId: ctx.sellerId, id: { in: staffIds } }, select: { id: true, name: true } })
    : [];
  const staffName = new Map(staff.map((u) => [u.id, u.name]));
  return {
    ok: true as const,
    value: {
      movements: page.map((m) => ({
        id: m.id,
        productId: m.option.productId,
        productName: m.option.product.name,
        optionId: m.optionId,
        optionName: m.option.name,
        delta: m.delta,
        stockAfter: m.stockAfter,
        type: m.reason,
        typeLabel: STOCK_MOVEMENT_TYPE_LABELS[m.reason],
        note: m.note,
        actor: {
          type: m.actorType,
          name: m.actorType === "SELLER_USER" ? (staffName.get(m.actorId ?? "") ?? "직원") : ACTOR_LABELS[m.actorType],
        },
        orderId: m.orderId,
        createdAt: m.createdAt,
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null,
    },
  };
}
