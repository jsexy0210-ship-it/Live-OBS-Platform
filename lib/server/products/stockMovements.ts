import type { ActorType, Prisma, PrismaClient, StockMovementReason } from "@prisma/client";
import { notFound } from "../authz/errors";
import { requireSellerRead, type TenantContext } from "../tenant/context";

// 재고 이력 조회(화면 SA-014 재고 관리, PRODUCT_MANAGE). 판매자 범위 안만 보이고, 다른 쇼핑몰 상품·옵션은 404.
// 최근순(seq 내림차순) keyset 커서. seq는 기록 순서로, 옵션마다 실제 적용 순서와 같다(createdAt은 트랜잭션 시작 시각이라
// 동시 처리에서 뒤바뀔 수 있어 정렬에 쓰지 않는다). 커서는 마지막 항목의 seq를 base64url로 감싼 값이다.
// stockAfter(결과 재고)는 이 기능 전에 쌓인 이력에서 null이다. 화면은 null이면 표시하지 않는다.

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

const BIGINT_MAX = BigInt("9223372036854775807");
const encodeCursor = (seq: bigint) => Buffer.from(`s${seq}`).toString("base64url");

function decodeCursor(raw: string): bigint | null {
  const m = /^s([1-9]\d{0,18})$/.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (!m) return null;
  const seq = BigInt(m[1]);
  // seq는 BIGINT라 그 범위를 넘으면 잘못된 커서로 본다(DB 오류 500 대신 400)
  return seq <= BIGINT_MAX ? seq : null;
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
    if (c === null) return { ok: false as const, reason: "invalid_cursor" as const };
    after = { seq: { lt: c } };
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
    orderBy: { seq: "desc" },
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
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null,
    },
  };
}
