import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { restoreOrderStock } from "../products/stock";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { refreshOrderRetention } from "../buyers/legalHold";
import { restoreOrderCoupon } from "../shop-coupons/service";
import { returnRewardForOrder } from "../payments/rewardUse";

// 무통장 입금 기한·미입금 자동 취소·자동 구매 제한(PRODUCT_SCOPE 「무통장 입금·구매 제한 기본값」, MASTER 결정).
// - 입금 기한: 주문 시각 + 판매자 설정(기본 사용·10일, 1시간~30일, 끌 수 있음). 주문할 때 Order.paymentDueAt에 고정한다.
// - 자동 취소: 기한이 지난 결제 대기 주문을 취소한다. 재고는 결제 때 차감하므로 되돌릴 것이 없다. 여러 번 돌려도 같은 결과(멱등).
//   정기 실행(cron) 연결은 인프라 승인 대기라 함수만 둔다.
// - 자동 구매 제한: 같은 쇼핑몰에서 미입금 자동 취소가 3회 쌓이면 30일 동안 새 주문을 막는다(판매자 설정으로 끌 수 있음).
//   「결제 후 취소 5회 → 30일」(기본 꺼짐): 구매자 사정(refundFault=BUYER)으로 표시한 환불이 5회 쌓이면 같은 식으로 막는다
//   (환불 처리 queue/service refundOrder에서 센다).
// 같은 판매자의 주문 생성과 같은 advisory lock(order_no:{sellerId}) 아래에서 처리해, 제한이 생기는 순간과 주문이 엇갈리지 않게 한다.

// 미입금 자동 취소 기간: 기본 사용·주문 후 24시간, 1시간~30일(대표님 결정 2026-10-03, 기간 범위·끄기는 카페24 방식)
export const DEFAULT_PAYMENT_DUE_HOURS = 24;
export const MAX_PAYMENT_DUE_HOURS = 720;
export const UNPAID_CANCEL_LIMIT = 3;
export const RESTRICTION_DAYS = 30;
export const RESTRICTION_REASON_UNPAID = "UNPAID_AUTO_CANCEL";
export const PAID_CANCEL_LIMIT = 5;
export const RESTRICTION_REASON_PAID_CANCEL = "PAID_CANCEL";

type Db = PrismaClient | Prisma.TransactionClient;
// autoCancelEnabled가 꺼져 있으면 새 주문에 입금 기한을 두지 않아 자동 취소되지 않는다(이미 기한이 붙은 주문은 그대로).
// restockOnCancel: 취소·반품 때 재고 자동 복구(기본 켜짐, lib/server/products/stock.ts).
// autoDeliver*: 배송 중 n일 뒤 자동 배송 완료, autoConfirm*: 배송 완료 n일 뒤 자동 구매 확정(기본 사용·7일, 1~30일, orders/delivery.ts).
export type OrderPolicy = {
  autoCancelEnabled: boolean;
  paymentDueHours: number;
  unpaidRestrictionEnabled: boolean;
  paidCancelRestrictionEnabled: boolean;
  restockOnCancel: boolean;
  autoDeliverEnabled: boolean;
  autoDeliverDays: number;
  autoConfirmEnabled: boolean;
  autoConfirmDays: number;
};
export const DEFAULT_AUTO_DAYS = 7;
export const MAX_AUTO_DAYS = 30;

type PolicyAnchors = { unpaidRestrictionEnabledAt: Date | null; paidCancelRestrictionEnabledAt: Date | null };

export async function getOrderPolicy(db: Db, sellerId: string): Promise<OrderPolicy & PolicyAnchors> {
  const p = await db.sellerOrderPolicy.findUnique({ where: { sellerId } });
  return p
    ? {
        autoCancelEnabled: p.autoCancelEnabled,
        paymentDueHours: p.paymentDueHours,
        unpaidRestrictionEnabled: p.unpaidRestrictionEnabled,
        unpaidRestrictionEnabledAt: p.unpaidRestrictionEnabledAt,
        paidCancelRestrictionEnabled: p.paidCancelRestrictionEnabled,
        paidCancelRestrictionEnabledAt: p.paidCancelRestrictionEnabledAt,
        restockOnCancel: p.restockOnCancel,
        autoDeliverEnabled: p.autoDeliverEnabled,
        autoDeliverDays: p.autoDeliverDays,
        autoConfirmEnabled: p.autoConfirmEnabled,
        autoConfirmDays: p.autoConfirmDays,
      }
    : {
        autoCancelEnabled: true,
        paymentDueHours: DEFAULT_PAYMENT_DUE_HOURS,
        unpaidRestrictionEnabled: true,
        unpaidRestrictionEnabledAt: null,
        paidCancelRestrictionEnabled: false,
        paidCancelRestrictionEnabledAt: null,
        restockOnCancel: true,
        autoDeliverEnabled: true,
        autoDeliverDays: DEFAULT_AUTO_DAYS,
        autoConfirmEnabled: true,
        autoConfirmDays: DEFAULT_AUTO_DAYS,
      };
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

// 마지막 제한(사유와 상관없이, 풀었으면 푼 시각, 아니면 시작 시각) 뒤에 쌓인 횟수가 기준에 닿으면 제한을 만든다.
// 판매자가 자동 제한을 (다시) 켰으면 켠 시각 뒤의 것만 센다(끈 동안 쌓인 횟수는 넣지 않음, MASTER 결정).
// - unpaid: 미입금 자동 취소(autoCancelledAt) 3회
// - paid_cancel: 구매자 사정(refundFault=BUYER)으로 표시한 환불(refundedAt) 5회. 판매자 사정·미지정(재고 부족 등)은 세지 않는다
//   (구매자를 잘못 막지 않게, MASTER 결정). 발송 전 환불도 판매자가 사유 주체를 고를 수 있다.
// 주문 생성과 같은 잠금(lockSellerOrders) 아래에서 부른다.
type RestrictionKind = "unpaid" | "paid_cancel";

function ruleOf(policy: Awaited<ReturnType<typeof getOrderPolicy>>, kind: RestrictionKind) {
  return kind === "unpaid"
    ? { enabled: policy.unpaidRestrictionEnabled, enabledAt: policy.unpaidRestrictionEnabledAt, limit: UNPAID_CANCEL_LIMIT, reason: RESTRICTION_REASON_UNPAID }
    : { enabled: policy.paidCancelRestrictionEnabled, enabledAt: policy.paidCancelRestrictionEnabledAt, limit: PAID_CANCEL_LIMIT, reason: RESTRICTION_REASON_PAID_CANCEL };
}

// 횟수를 세기 시작하는 기준 시각: 설정을 (다시) 켠 시각과 마지막 제한(사유 무관, 풀었으면 푼 시각, 아니면 시작 시각) 중 늦은 쪽.
async function restrictionAnchor(tx: Prisma.TransactionClient, sellerId: string, buyerMemberId: string, enabledAt: Date | null): Promise<Date> {
  const last = await tx.buyerPurchaseRestriction.findFirst({ where: { sellerId, buyerMemberId }, orderBy: { startsAt: "desc" } });
  const anchors = [new Date(0), enabledAt, last ? (last.liftedAt ?? last.startsAt) : null].filter((d): d is Date => d !== null);
  return new Date(Math.max(...anchors.map((d) => d.getTime())));
}

// 판매자별 단조 시계. 구매 제한 횟수의 기준이나 사건이 되는 시각(환불 refundedAt, 미입금 자동 취소 autoCancelledAt,
// 제한 시작 startsAt, 제한 풀기 liftedAt, 설정 켜기 enabledAt)은 모두 이 시계로 찍는다. 주문 생성 잠금(lockSellerOrders) 아래에서만 부른다.
// max(DB 시계, 마지막으로 찍은 시각 + 1ms)를 찍고 저장하므로, 같은 판매자 안에서는 찍은 순서가 곧 시각 순서다(같은 밀리초 문제 없음).
export async function sellerEventClock(tx: Prisma.TransactionClient, sellerId: string): Promise<Date> {
  const clock = await dbClock(tx);
  const row = await tx.sellerOrderPolicy.findUnique({ where: { sellerId }, select: { lastEventClockAt: true } });
  const last = row?.lastEventClockAt;
  const at = last && last.getTime() >= clock.getTime() ? new Date(last.getTime() + 1) : clock;
  await tx.sellerOrderPolicy.upsert({ where: { sellerId }, create: { sellerId, lastEventClockAt: at }, update: { lastEventClockAt: at } });
  return at;
}

export async function maybeRestrict(tx: Prisma.TransactionClient, sellerId: string, buyerMemberId: string, now: Date, kind: RestrictionKind = "unpaid") {
  const rule = ruleOf(await getOrderPolicy(tx, sellerId), kind);
  if (!rule.enabled) return null;
  // 탈퇴한 회원에게는 구매 제한을 만들지 않는다(쓸 일이 없고 탈퇴 때 지운 기록이 다시 생기지 않게, MASTER 결정 2026-10-03)
  const member = await tx.buyerMember.findUnique({ where: { id: buyerMemberId }, select: { status: true } });
  if (!member || member.status === "WITHDRAWN") return null;
  // 다른 제한이 걸려 있어도 기준에 닿으면 새 제한을 만든다(앞 제한이 먼저 끝나도 막히게). 새 제한이 기준 시각이 되므로 겹쳐 만들지 않는다.
  const anchor = await restrictionAnchor(tx, sellerId, buyerMemberId, rule.enabledAt);
  const count = await tx.order.count({
    where:
      kind === "unpaid"
        ? { sellerId, buyerMemberId, autoCancelledAt: { gt: anchor } }
        : { sellerId, buyerMemberId, status: "REFUNDED", refundedAt: { gt: anchor }, refundFault: "BUYER" },
  });
  if (count < rule.limit) return null;
  const endsAt = new Date(now.getTime() + RESTRICTION_DAYS * 24 * 60 * 60 * 1000);
  const r = await tx.buyerPurchaseRestriction.create({
    data: { sellerId, buyerMemberId, reason: rule.reason, startsAt: now, endsAt },
  });
  await writeAudit(tx, {
    actorType: "SYSTEM",
    sellerId,
    action: "buyer.purchase_restriction.create",
    targetType: "BuyerMember",
    targetId: buyerMemberId,
    after: { reason: rule.reason, ...(kind === "unpaid" ? { unpaidCancels: count } : { paidCancels: count }), endsAt },
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
  const failed: string[] = [];
  for (const o of due) {
    // 한 건이 실패해도 나머지 주문은 계속 처리한다. 실패한 건은 오류 로그와 감사 로그로 남기고 다음 실행에서 다시 시도한다.
    try {
      const outcome = await db.$transaction(async (tx) => {
        await lockSellerOrders(tx, o.sellerId);
        // 잠금을 잡은 뒤의 실제 DB 시각으로 처리한다. 제한은 이 트랜잭션이 끝나야 보이고, 주문 생성도 같은 잠금을 잡으므로
        // 제한이 생긴 뒤 잠금을 얻은 주문은 반드시 제한을 본다(시각 비교에 기대지 않음).
        // 판매자 시계로 찍는다(기준 시각과 순서가 뒤집히지 않게)
        const now = opts.now ?? (await sellerEventClock(tx, o.sellerId));
        // 그사이 결제·취소된 주문은 건드리지 않는다
        const moved = await tx.order.updateMany({
          where: { id: o.id, sellerId: o.sellerId, status: "PENDING_PAYMENT", paymentDueAt: { lte: now } },
          data: { status: "CANCELLED", cancelledAt: now, autoCancelledAt: now },
        });
        if (moved.count !== 1) return null;
        await tx.orderStatusHistory.create({
          data: { sellerId: o.sellerId, orderId: o.id, fromStatus: "PENDING_PAYMENT", toStatus: "CANCELLED", actorType: "SYSTEM", reason: "payment_overdue", createdAt: now },
        });
        // 주문 때 뺀 재고(ORDER 상품)가 있으면 되돌린다(판매자 설정 restockOnCancel)
        await restoreOrderStock(tx, { sellerId: o.sellerId, orderId: o.id, reason: "CANCEL", now, actor: { actorType: "SYSTEM", actorId: null } });
        await restoreOrderCoupon(tx, { sellerId: o.sellerId, orderId: o.id, now, reason: "payment_overdue" });
        // 쓴 적립금은 전부 돌려준다(payments/rewardUse.ts, 대표님 결정 2026-10-05)
        await returnRewardForOrder(tx, { sellerId: o.sellerId, orderId: o.id, now, reason: "payment_overdue" });
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
        await refreshOrderRetention(tx, o.sellerId, now, { orderId: o.id });
        return { restriction: await maybeRestrict(tx, o.sellerId, o.buyerMemberId, now) };
      });
      // 커밋된 뒤에만 결과에 넣는다
      if (outcome) {
        cancelled.push(o.id);
        if (outcome.restriction) restricted.push({ sellerId: o.sellerId, buyerMemberId: o.buyerMemberId, endsAt: outcome.restriction.endsAt });
      }
    } catch (e) {
      console.error("[cancelOverdueOrders] 자동 취소 실패", o.id, e);
      failed.push(o.id);
      await writeAudit(db, {
        actorType: "SYSTEM",
        sellerId: o.sellerId,
        action: "order.auto_cancel_failed",
        targetType: "Order",
        targetId: o.id,
        reason: e instanceof Error ? e.message.slice(0, 200) : "unknown",
      }).catch((logError) => console.error("[cancelOverdueOrders] 감사 로그 실패", o.id, logError));
    }
  }
  return { cancelled, restricted, failed };
}

// 미입금 알림 대상(대표님 결정 2026-10-03, PRODUCT_SCOPE): 알림 시각이 지났고 기한은 아직 안 지난 결제 대기 주문.
// 알림 시각 = 기한 하루 전. 입금 기간(기한 − 주문 시각)이 하루 이하면 기한 1시간 전. 조회만 한다.
// 실제로 보낼 때는 중복 발송을 막도록 orders/notifications.ts claimPaymentDueSoon으로 잡는다.
export async function listPaymentDueSoon(db: PrismaClient, opts: { now?: Date } = {}) {
  const now = opts.now ?? (await dbNow(db));
  return db.$queryRaw<{ id: string; sellerId: string; buyerMemberId: string; orderNo: number; totalAmount: number; paymentDueAt: Date }[]>`
    SELECT "id", "sellerId", "buyerMemberId", "orderNo", "totalAmount", "paymentDueAt" FROM "Order"
    WHERE "status" = 'PENDING_PAYMENT' AND "paymentDueAt" > ${now}
      AND "paymentDueAt" - CASE WHEN "paymentDueAt" - "createdAt" > INTERVAL '1 day' THEN INTERVAL '1 day' ELSE INTERVAL '1 hour' END <= ${now}
    ORDER BY "paymentDueAt" ASC`;
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
    // 판매자 시계로 찍어 푼 시각이 그 제한을 만든 사건들보다 늘 뒤가 되게 한다
    const now = await sellerEventClock(tx, ctx.sellerId);
    const active = await activeRestriction(tx, ctx.sellerId, buyerMemberId, now);
    if (!active) return { ok: false as const, reason: "no_restriction" as const };
    // 사유가 다른 제한이 겹쳐 있을 수 있으니(미입금·결제 후 취소) 걸려 있는 제한을 모두 푼다
    const lifted = await tx.buyerPurchaseRestriction.updateMany({
      where: { sellerId: ctx.sellerId, buyerMemberId, liftedAt: null, endsAt: { gt: now } },
      data: { liftedAt: now, liftedById: ctx.actorId },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "buyer.purchase_restriction.lift",
      targetType: "BuyerMember",
      targetId: buyerMemberId,
      reason,
      before: { endsAt: active.endsAt },
      after: { liftedAt: now, lifted: lifted.count },
    });
    return { ok: true as const, value: { buyerMemberId, liftedAt: now } };
  });
}

export async function readOrderPolicy(db: PrismaClient, ctx: TenantContext): Promise<OrderPolicy> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const { unpaidRestrictionEnabledAt: _u, paidCancelRestrictionEnabledAt: _p, ...policy } = await getOrderPolicy(db, ctx.sellerId);
  return policy;
}

const isAutoDays = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_AUTO_DAYS;

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
    typeof b.unpaidRestrictionEnabled !== "boolean" ||
    (b.paidCancelRestrictionEnabled !== undefined && typeof b.paidCancelRestrictionEnabled !== "boolean") ||
    (b.restockOnCancel !== undefined && typeof b.restockOnCancel !== "boolean") ||
    (b.autoDeliverEnabled !== undefined && typeof b.autoDeliverEnabled !== "boolean") ||
    (b.autoConfirmEnabled !== undefined && typeof b.autoConfirmEnabled !== "boolean") ||
    (b.autoDeliverDays !== undefined && !isAutoDays(b.autoDeliverDays)) ||
    (b.autoConfirmDays !== undefined && !isAutoDays(b.autoConfirmDays))
  ) {
    return { ok: false as const, reason: "invalid_order_policy" as const };
  }
  return db.$transaction(async (tx) => {
    // 같은 판매자의 자동 취소·주문과 순서를 맞춘다
    await lockSellerOrders(tx, ctx.sellerId);
    // 결제 후 취소 제한·restockOnCancel·자동 배송 완료·자동 구매 확정은 빼고 보내면 지금 값을 그대로 둔다
    const current = await getOrderPolicy(tx, ctx.sellerId);
    const policy: OrderPolicy = {
      autoCancelEnabled: b.autoCancelEnabled as boolean,
      paymentDueHours: h,
      unpaidRestrictionEnabled: b.unpaidRestrictionEnabled as boolean,
      paidCancelRestrictionEnabled: typeof b.paidCancelRestrictionEnabled === "boolean" ? b.paidCancelRestrictionEnabled : current.paidCancelRestrictionEnabled,
      restockOnCancel: typeof b.restockOnCancel === "boolean" ? b.restockOnCancel : current.restockOnCancel,
      autoDeliverEnabled: typeof b.autoDeliverEnabled === "boolean" ? b.autoDeliverEnabled : current.autoDeliverEnabled,
      autoDeliverDays: isAutoDays(b.autoDeliverDays) ? b.autoDeliverDays : current.autoDeliverDays,
      autoConfirmEnabled: typeof b.autoConfirmEnabled === "boolean" ? b.autoConfirmEnabled : current.autoConfirmEnabled,
      autoConfirmDays: isAutoDays(b.autoConfirmDays) ? b.autoConfirmDays : current.autoConfirmDays,
    };
    const { unpaidRestrictionEnabledAt: _u, paidCancelRestrictionEnabledAt: _p, ...before } = current;
    // 꺼져 있다가 켜면 켠 시각을 남긴다(그 뒤의 횟수만 센다). 끄더라도 이미 걸린 제한은 그대로 둔다.
    // 켠 시각은 판매자 시계로 찍는다(켜기 전 사건은 늘 이보다 앞, 켠 뒤 사건은 늘 이보다 뒤).
    const turnedOn = (was: boolean, is: boolean) => !was && is;
    const unpaidOn = turnedOn(before.unpaidRestrictionEnabled, policy.unpaidRestrictionEnabled);
    const paidOn = turnedOn(before.paidCancelRestrictionEnabled, policy.paidCancelRestrictionEnabled);
    const at = unpaidOn || paidOn ? await sellerEventClock(tx, ctx.sellerId) : null;
    const data = {
      ...policy,
      ...(unpaidOn ? { unpaidRestrictionEnabledAt: at } : {}),
      ...(paidOn ? { paidCancelRestrictionEnabledAt: at } : {}),
    };
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
