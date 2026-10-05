import type { Prisma, PrismaClient } from "@prisma/client";
import { shopOpen } from "../buyers/signup";
import { dbClock } from "../orders/overdue";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 재입고 알림(SA-017). 규칙:
// - 구매자(로그인 회원)는 지금 품절인 상품에만 신청한다. 회원당 MAX_RESTOCK_ALERTS개, 상품마다 한 줄(다시 신청하면 그대로 성공).
// - 흐름: WAITING(품절 기다림) → QUEUED(재고가 들어와 발송 대기) → SENT(발송 기록). 실제 발송은 아직 없고 기록만 남긴다.
// - 재고가 들어오는 길이 여럿(수동 증감·일괄·취소 복구)이라 훑기(sweepRestock)로 판단한다: 판매 중이고 재고가 있는 상품의 WAITING을 QUEUED로.
//   훑기는 판매자 목록을 열 때와 구매자 신청·조회 때 돈다. 멱등이라 여러 번 돌아도 같다.
// - 21~08시(KST)에 들어온 재고는 아침 8시(KST)로 미룬다(notifyAt). 야간 「바로 보내기」 허용은 대표님 결정 대기라 만들지 않았다.
// - 판매자 화면은 신청한 회원을 드러내지 않고 상품별 수만 보여 준다. 모든 조회·쓰기는 sellerId로 묶는다.

type Tx = Prisma.TransactionClient;
export type RestockScope = { sellerId: string; buyerMemberId: string };

export const MAX_RESTOCK_ALERTS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const KST_MS = 9 * 3600_000;

export const RESTOCK_MESSAGES = {
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  invalid_restock_alert: "알림을 받을 상품을 다시 확인해 주세요",
  product_unavailable: "지금은 알림을 신청할 수 없는 상품이에요",
  not_sold_out: "재고가 있는 상품이에요. 바로 주문해 주세요",
  restock_full: `재입고 알림은 ${MAX_RESTOCK_ALERTS}개까지 신청할 수 있어요. 지난 알림을 지운 뒤 다시 신청해 주세요`,
  restock_alert_not_found: "신청한 알림을 찾을 수 없어요",
} as const;
export type RestockFailure = keyof typeof RESTOCK_MESSAGES;
export const restockErrorBody = (reason: RestockFailure) => ({ error: reason, message: RESTOCK_MESSAGES[reason] });
export const restockFailureStatus = (reason: RestockFailure) =>
  reason === "shop_unavailable" ? 402 : reason === "invalid_restock_alert" ? 400 : reason === "restock_alert_not_found" ? 404 : 409;

// 발송 예정 시각: 21시 이후~08시 전(KST)이면 다음 아침 8시(KST), 아니면 바로.
export function restockNotifyAt(now: Date): Date {
  const kst = new Date(now.getTime() + KST_MS);
  const h = kst.getUTCHours();
  if (h >= 8 && h < 21) return now;
  const day = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + (h >= 21 ? 1 : 0), 8);
  return new Date(day - KST_MS);
}

// 지금 품절: 판매 중지·숨김·삭제가 아니고, 품절 표시이거나 살 수 있는 품목이 없음.
const SOLD_OUT_PRODUCT = (p: { status: string; options: { stock: number }[] }) => p.status === "SOLD_OUT" || !p.options.some((o) => o.stock > 0);

export async function sweepRestock(db: PrismaClient, sellerId: string) {
  const now = await dbClock(db);
  const notifyAt = restockNotifyAt(now);
  await db.$executeRaw`
    UPDATE "RestockAlert" a SET "status" = 'QUEUED', "restockedAt" = ${now}, "notifyAt" = ${notifyAt}
    FROM "Product" p
    WHERE a."sellerId" = ${sellerId}::uuid AND a."status" = 'WAITING' AND p."sellerId" = a."sellerId" AND p."id" = a."productId"
      AND p."deletedAt" IS NULL AND p."status" = 'ON_SALE'
      AND EXISTS (SELECT 1 FROM "ProductOption" o WHERE o."productId" = p."id" AND o."deletedAt" IS NULL AND o."stock" > 0)`;
  await db.$executeRaw`
    UPDATE "RestockAlert" SET "status" = 'SENT', "notifiedAt" = ${now}
    WHERE "sellerId" = ${sellerId}::uuid AND "status" = 'QUEUED' AND "notifyAt" <= ${now}`;
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: RestockFailure };

export const lockBuyerRestock = (tx: Tx, s: RestockScope) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_restock:${s.sellerId}:${s.buyerMemberId}`}))`;

const productSelect = { id: true, name: true, status: true, deletedAt: true, options: { where: { deletedAt: null }, select: { stock: true } } } as const;

// 신청하기. 응답 created(새로 신청함)와 신청 개수. 지난 알림(SENT)을 다시 신청하면 WAITING으로 돌아간다.
export async function applyRestock(db: PrismaClient, s: RestockScope, productId: unknown): Promise<Result<{ created: boolean; count: number }>> {
  if (!isId(productId)) return { ok: false, reason: "invalid_restock_alert" };
  if (!(await shopOpen(db, s.sellerId))) return { ok: false, reason: "shop_unavailable" };
  await sweepRestock(db, s.sellerId);
  return db.$transaction(async (tx): Promise<Result<{ created: boolean; count: number }>> => {
    await lockBuyerRestock(tx, s);
    if ((await tx.buyerMember.count({ where: { id: s.buyerMemberId, sellerId: s.sellerId, status: "ACTIVE", deletedAt: null } })) !== 1) return { ok: false, reason: "restock_alert_not_found" };
    const p = await tx.product.findFirst({ where: { id: productId, sellerId: s.sellerId, deletedAt: null, status: { in: ["ON_SALE", "SOLD_OUT"] } }, select: productSelect });
    if (!p) return { ok: false, reason: "product_unavailable" };
    const where = { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId };
    const cur = await tx.restockAlert.findUnique({ where: { buyerMemberId_productId: { buyerMemberId: s.buyerMemberId, productId } }, select: { id: true, status: true } });
    if (cur && cur.status !== "SENT") return { ok: true, value: { created: false, count: await tx.restockAlert.count({ where }) } };
    if (!SOLD_OUT_PRODUCT(p)) return { ok: false, reason: "not_sold_out" };
    if (cur) {
      await tx.restockAlert.update({ where: { id: cur.id }, data: { status: "WAITING", createdAt: new Date(), restockedAt: null, notifyAt: null, notifiedAt: null } });
    } else {
      if ((await tx.restockAlert.count({ where })) >= MAX_RESTOCK_ALERTS) return { ok: false, reason: "restock_full" };
      await tx.restockAlert.create({ data: { ...where, productId } });
    }
    return { ok: true, value: { created: true, count: await tx.restockAlert.count({ where }) } };
  });
}

// 비우기(탈퇴). 호출하는 쪽이 lockBuyerRestock을 먼저 잡는다.
export const clearRestock = (tx: Tx, s: RestockScope) => tx.restockAlert.deleteMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } });

// 취소(상품 id로). 신청하지 않은 상품이면 removed: false.
export async function cancelRestock(db: PrismaClient, s: RestockScope, productId: string): Promise<Result<{ removed: boolean; count: number }>> {
  if (!isId(productId)) return { ok: false, reason: "invalid_restock_alert" };
  return db.$transaction(async (tx) => {
    await lockBuyerRestock(tx, s);
    const where = { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId };
    const { count } = await tx.restockAlert.deleteMany({ where: { ...where, productId } });
    return { ok: true as const, value: { removed: count > 0, count: await tx.restockAlert.count({ where }) } };
  });
}

// 내 신청 목록: 최근 신청 순. 응답 { items: [{ productId, name, status, requestedAt, notifyAt, notifiedAt }], count }
export async function listMyRestock(db: PrismaClient, s: RestockScope) {
  await sweepRestock(db, s.sellerId);
  const rows = await db.restockAlert.findMany({
    where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId },
    select: { status: true, createdAt: true, notifyAt: true, notifiedAt: true, product: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const items = rows.map((r) => ({ productId: r.product.id, name: r.product.name, status: r.status, requestedAt: r.createdAt, notifyAt: r.notifyAt, notifiedAt: r.notifiedAt }));
  return { items, count: items.length };
}

// 판매자 목록(PRODUCT_MANAGE): 신청이 있는 상품별 수. 신청한 회원은 드러내지 않는다.
// 응답 { items: [{ productId, name, soldOut, waiting, queued, sent, nextNotifyAt, lastNotifiedAt }] } — 기다리는 사람이 많은 순.
export async function listRestockAlerts(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  await sweepRestock(db, ctx.sellerId);
  const groups = await db.restockAlert.groupBy({
    by: ["productId", "status"],
    where: { sellerId: ctx.sellerId, product: { deletedAt: null } },
    _count: { _all: true },
    _min: { notifyAt: true },
    _max: { notifiedAt: true },
  });
  const ids = [...new Set(groups.map((g) => g.productId))];
  const products = await db.product.findMany({ where: { sellerId: ctx.sellerId, id: { in: ids } }, select: productSelect });
  const byId = new Map(products.map((p) => [p.id, p]));
  const items = ids.map((id) => {
    const p = byId.get(id)!;
    const g = (st: string) => groups.find((x) => x.productId === id && x.status === st);
    return {
      productId: id,
      name: p.name,
      soldOut: SOLD_OUT_PRODUCT(p),
      waiting: g("WAITING")?._count._all ?? 0,
      queued: g("QUEUED")?._count._all ?? 0,
      sent: g("SENT")?._count._all ?? 0,
      nextNotifyAt: g("QUEUED")?._min.notifyAt ?? null,
      lastNotifiedAt: g("SENT")?._max.notifiedAt ?? null,
    };
  });
  items.sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId));
  return { items };
}
