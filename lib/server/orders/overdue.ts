import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 무통장 입금 기한·미입금 자동 취소·자동 구매 제한(PRODUCT_SCOPE 「무통장 입금·구매 제한 기본값」, MASTER 결정).
// - 입금 기한: 주문 시각 + 판매자 설정(기본 사용·10일, 1시간~30일, 끌 수 있음). 주문할 때 Order.paymentDueAt에 고정한다.
// - 자동 취소: 기한이 지난 결제 대기 주문을 취소한다. 재고는 결제 때 차감하므로 되돌릴 것이 없다. 여러 번 돌려도 같은 결과(멱등).
//   정기 실행(cron) 연결은 인프라 승인 대기라 함수만 둔다.
// - 자동 구매 제한: 같은 쇼핑몰에서 미입금 자동 취소가 3회 쌓이면 30일 동안 새 주문을 막는다(판매자 설정으로 끌 수 있음).
// 같은 판매자의 주문 생성과 같은 advisory lock(order_no:{sellerId}) 아래에서 처리해, 제한이 생기는 순간과 주문이 엇갈리지 않게 한다.

// 미입금 자동 취소 기간: 기본 사용·10일(240시간), 1시간~30일(카페24 방식, 대표님 결정 2026-10-03)
export const DEFAULT_PAYMENT_DUE_HOURS = 240;
export const MAX_PAYMENT_DUE_HOURS = 720;
export const UNPAID_CANCEL_LIMIT = 3;
export const RESTRICTION_DAYS = 30;
export const RESTRICTION_REASON_UNPAID = "UNPAID_AUTO_CANCEL";
export const PAYMENT_REMINDER_MINUTES = 60;

type Db = PrismaClient | Prisma.TransactionClient;
// autoCancelEnabled가 꺼져 있으면 새 주문에 입금 기한을 두지 않아 자동 취소되지 않는다(이미 기한이 붙은 주문은 그대로).
export type OrderPolicy = { autoCancelEnabled: boolean; paymentDueHours: number; unpaidRestrictionEnabled: boolean };

export async function getOrderPolicy(db: Db, sellerId: string): Promise<OrderPolicy & { unpaidRestrictionEnabledAt: Date | null }> {
  const p = await db.sellerOrderPolicy.findUnique({ where: { sellerId } });
  return p
    ? {
        autoCancelEnabled: p.autoCancelEnabled,
        paymentDueHours: p.paymentDueHours,
        unpaidRestrictionEnabled: p.unpaidRestrictionEnabled,
        unpaidRestrictionEnabledAt: p.unpaidRestrictionEnabledAt,
      }
    : { autoCancelEnabled: true, paymentDueHours: DEFAULT_PAYMENT_DUE_HOURS, unpaidRestrictionEnabled: true, unpaidRestrictionEnabledAt: null };
}

export const lockSellerOrders = (tx: Prisma.TransactionClient, sellerId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order_no:${sellerId}`}))`;

// 잠금을 잡은 뒤의 실제 DB 시각. dbNow(now())는 트랜잭션 시작 시각이라 잠금을 기다린 시간이 빠진다.
export async function dbClock(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return rows[0].now;
}

// 걸려 있는 제한 = 풀지 않았고 끝나는 시각 전. 시작 시각은 보지 않는다(제한이 생긴 뒤 들어온 주문은 시각과 상관없이 막는다).
export function activeRestriction(db: Db, sellerId: string, buyerMemberId: string, now: Date) {
  return db.buyerPurchaseRestriction.findFirst({
    where: { sellerId, buyerMemberId, liftedAt: null, endsAt: { gt: now } },
    orderBy: { endsAt: "desc" },
  });
}

// 마지막 제한(풀었으면 푼 시각, 아니면 시작 시각) 뒤에 생긴 자동 취소가 기준 횟수에 닿으면 제한을 만든다.
// 판매자가 자동 제한을 다시 켰으면 켠 시각 뒤의 자동 취소만 센다(끈 동안 쌓인 횟수는 넣지 않음, MASTER 결정).
async function maybeRestrict(tx: Prisma.TransactionClient, sellerId: string, buyerMemberId: string, now: Date) {
  const policy = await getOrderPolicy(tx, sellerId);
  if (!policy.unpaidRestrictionEnabled) return null;
  if (await activeRestriction(tx, sellerId, buyerMemberId, now)) return null;
  const last = await tx.buyerPurchaseRestriction.findFirst({ where: { sellerId, buyerMemberId }, orderBy: { startsAt: "desc" } });
  const anchors = [new Date(0), policy.unpaidRestrictionEnabledAt, last ? (last.liftedAt ?? last.startsAt) : null].filter((d): d is Date => d !== null);
  const anchor = new Date(Math.max(...anchors.map((d) => d.getTime())));
  const count = await tx.order.count({ where: { sellerId, buyerMemberId, autoCancelledAt: { gt: anchor } } });
  if (count < UNPAID_CANCEL_LIMIT) return null;
  const endsAt = new Date(now.getTime() + RESTRICTION_DAYS * 24 * 60 * 60 * 1000);
  const r = await tx.buyerPurchaseRestriction.create({
    data: { sellerId, buyerMemberId, reason: RESTRICTION_REASON_UNPAID, startsAt: now, endsAt },
  });
  await writeAudit(tx, {
    actorType: "SYSTEM",
    sellerId,
    action: "buyer.purchase_restriction.create",
    targetType: "BuyerMember",
    targetId: buyerMemberId,
    after: { reason: RESTRICTION_REASON_UNPAID, unpaidCancels: count, endsAt },
  });
  return r;
}

// 기한이 지난 결제 대기 주문 자동 취소. 한 번에 limit건까지 처리하고, 남으면 다음 실행에서 이어 간다.
export async function cancelOverdueOrders(db: PrismaClient, opts: { now?: Date; limit?: number } = {}) {
  const asOf = opts.now ?? (await dbNow(db));
  const due = await db.order.findMany({
    where: { status: "PENDING_PAYMENT", paymentDueAt: { lte: asOf } },
    orderBy: { paymentDueAt: "asc" },
    take: Math.min(opts.limit ?? 100, 500),
    select: { id: true, sellerId: true, buyerMemberId: true },
  });
  const cancelled: string[] = [];
  const restricted: { sellerId: string; buyerMemberId: string; endsAt: Date }[] = [];
  for (const o of due) {
    await db.$transaction(async (tx) => {
      await lockSellerOrders(tx, o.sellerId);
      // 잠금을 잡은 뒤의 실제 DB 시각으로 처리한다. 제한은 이 트랜잭션이 끝나야 보이고, 주문 생성도 같은 잠금을 잡으므로
      // 제한이 생긴 뒤 잠금을 얻은 주문은 반드시 제한을 본다(시각 비교에 기대지 않음).
      const now = opts.now ?? (await dbClock(tx));
      // 그사이 결제·취소된 주문은 건드리지 않는다
      const moved = await tx.order.updateMany({
        where: { id: o.id, sellerId: o.sellerId, status: "PENDING_PAYMENT", paymentDueAt: { lte: now } },
        data: { status: "CANCELLED", cancelledAt: now, autoCancelledAt: now },
      });
      if (moved.count !== 1) return;
      await tx.orderStatusHistory.create({
        data: { sellerId: o.sellerId, orderId: o.id, fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED", actorType: "SYSTEM", reason: "payment_overdue", createdAt: now },
      });
      await writeAudit(tx, {
        actorType: "SYSTEM",
        sellerId: o.sellerId,
        action: "order.auto_cancel",
        targetType: "Order",
        targetId: o.id,
        reason: "payment_overdue",
        before: { status: "PENDING_PAYMENT" },
        after: { status: "CANCELLED" },
      });
      cancelled.push(o.id);
      const r = await maybeRestrict(tx, o.sellerId, o.buyerMemberId, now);
      if (r) restricted.push({ sellerId: o.sellerId, buyerMemberId: o.buyerMemberId, endsAt: r.endsAt });
    });
  }
  return { cancelled, restricted };
}

// 입금 기한 1시간 전 알림 대상(기한이 지금 뒤, 1시간 안). 발송 연동 전이라 대상 조회만 한다.
export async function listPaymentDueSoon(db: PrismaClient, opts: { now?: Date; withinMinutes?: number } = {}) {
  const now = opts.now ?? (await dbNow(db));
  const until = new Date(now.getTime() + (opts.withinMinutes ?? PAYMENT_REMINDER_MINUTES) * 60 * 1000);
  return db.order.findMany({
    where: { status: "PENDING_PAYMENT", paymentDueAt: { gt: now, lte: until } },
    orderBy: { paymentDueAt: "asc" },
    select: { id: true, sellerId: true, buyerMemberId: true, orderNo: true, totalAmount: true, paymentDueAt: true },
  });
}

// 판매자: 지금 걸려 있는 구매 제한 목록(MEMBER_POINTS)
export async function listActiveRestrictions(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const now = await dbNow(db);
  return db.buyerPurchaseRestriction.findMany({
    where: { sellerId: ctx.sellerId, liftedAt: null, endsAt: { gt: now } },
    orderBy: { startsAt: "desc" },
    take: 200,
    select: { id: true, buyerMemberId: true, reason: true, startsAt: true, endsAt: true, buyerMember: { select: { broadcastNickname: true } } },
  });
}

// 판매자: 구매 제한 풀기(MEMBER_POINTS, 감사 로그). 풀린 뒤부터 자동 취소 횟수를 새로 센다.
export async function liftRestriction(db: PrismaClient, ctx: TenantContext, buyerMemberId: string, rawReason?: unknown) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  // 사유는 선택. 넣었다면 글자 검사를 통과해야 한다(NUL·서로게이트 등은 400, 자르지 않음).
  const reason = rawReason === undefined || rawReason === null || rawReason === "" ? undefined : cleanText(rawReason, 200, "multiline");
  if (reason === null) return { ok: false as const, reason: "invalid_reason" as const };
  return db.$transaction(async (tx) => {
    await lockSellerOrders(tx, ctx.sellerId);
    const now = await dbClock(tx);
    const active = await activeRestriction(tx, ctx.sellerId, buyerMemberId, now);
    if (!active) return { ok: false as const, reason: "no_restriction" as const };
    await tx.buyerPurchaseRestriction.update({ where: { id: active.id }, data: { liftedAt: now, liftedById: ctx.actorId } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "buyer.purchase_restriction.lift",
      targetType: "BuyerMember",
      targetId: buyerMemberId,
      reason,
      before: { endsAt: active.endsAt },
      after: { liftedAt: now },
    });
    return { ok: true as const, value: { buyerMemberId, liftedAt: now } };
  });
}

export async function readOrderPolicy(db: PrismaClient, ctx: TenantContext): Promise<OrderPolicy> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const { autoCancelEnabled, paymentDueHours, unpaidRestrictionEnabled } = await getOrderPolicy(db, ctx.sellerId);
  return { autoCancelEnabled, paymentDueHours, unpaidRestrictionEnabled };
}

// 판매자 주문 정책 변경(SHOP_SETTINGS). 자동 취소 사용 여부, 기간은 1~720시간(30일) 정수. 바꾼 설정은 다음 주문부터.
export async function updateOrderPolicy(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!raw || typeof raw !== "object") return { ok: false as const, reason: "invalid_order_policy" as const };
  const b = raw as Record<string, unknown>;
  const h = b.paymentDueHours;
  if (
    typeof b.autoCancelEnabled !== "boolean" ||
    typeof h !== "number" ||
    !Number.isInteger(h) ||
    h < 1 ||
    h > MAX_PAYMENT_DUE_HOURS ||
    typeof b.unpaidRestrictionEnabled !== "boolean"
  ) {
    return { ok: false as const, reason: "invalid_order_policy" as const };
  }
  const policy: OrderPolicy = { autoCancelEnabled: b.autoCancelEnabled, paymentDueHours: h, unpaidRestrictionEnabled: b.unpaidRestrictionEnabled };
  return db.$transaction(async (tx) => {
    // 같은 판매자의 자동 취소·주문과 순서를 맞춘다
    await lockSellerOrders(tx, ctx.sellerId);
    const { unpaidRestrictionEnabledAt: _at, ...before } = await getOrderPolicy(tx, ctx.sellerId);
    // 꺼져 있다가 켜면 켠 시각을 남긴다(그 뒤 자동 취소만 센다). 끄더라도 이미 걸린 제한은 그대로 둔다.
    const reEnabled = !before.unpaidRestrictionEnabled && policy.unpaidRestrictionEnabled;
    const data = { ...policy, ...(reEnabled ? { unpaidRestrictionEnabledAt: await dbClock(tx) } : {}) };
    await tx.sellerOrderPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "order_policy.update",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before,
      after: policy,
    });
    return { ok: true as const, policy };
  });
}
