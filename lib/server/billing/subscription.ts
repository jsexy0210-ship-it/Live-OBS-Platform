import { Prisma, type ActorType, type PrismaClient, type SubscriptionPayment } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { addOneMonth, sellerAccess, type SellerAccess } from "./access";
import type { BillingProvider, ChargeResult } from "./provider";
import { openBillingKey, sealBillingKey } from "./secret";

// 플랫폼 구독(판매자 → 플랫폼). 카드 자동결제(빌링키)만 쓰고 금액은 요금제의 판매가(부가세 포함)다.
// 실제 결제는 PG 공급자 인터페이스로만 하며, 이 저장소에는 가짜 공급자만 있다.
// 결제 시점(MASTER 결정 2026-10-03):
// - 체험하기 중에 구독을 시작하면 카드만 등록하고, 첫 결제는 체험하기가 끝나는 시각에 예약 실행이 한다.
// - 다음 달 결제는 기간 끝 하루 전에 한다.
// - 자동결제가 실패하면 하루 간격으로 3번 다시 시도하고, 실패한 때부터 7일 동안은 계속 쓸 수 있다(유예).
//   판매자가 카드를 바꾸면 바로 다시 결제한다.

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export const DEFAULT_PLAN_CODE = "STANDARD";
const DAY_MS = 24 * 60 * 60 * 1000;
export const RENEW_LEAD_MS = DAY_MS;
export const RETRY_INTERVAL_MS = DAY_MS;
export const MAX_RETRIES = 3;
export const GRACE_MS = 7 * DAY_MS;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const after = (d: Date, ms: number) => new Date(d.getTime() + ms);

async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

// 모든 구독 변경은 판매자 행을 먼저 잠근다(잠금 순서를 같게 해 교착을 막는다).
async function lockSeller(tx: Tx, sellerId: string) {
  await tx.$queryRaw`SELECT id FROM "Seller" WHERE id = ${sellerId}::uuid FOR UPDATE`;
}

const ACCESS_SELECT = { status: true, currentPeriodEnd: true, nextChargeAt: true, graceUntil: true, cancelAtPeriodEnd: true } as const;

export async function sellerAccessFor(db: Db, sellerId: string, now: Date): Promise<SellerAccess> {
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: { trialEndsAt: true, subscription: { select: ACCESS_SELECT } },
  });
  if (!seller) return "expired";
  return sellerAccess({ trialEndsAt: seller.trialEndsAt, subscription: seller.subscription }, now);
}

// ───────────── 조회 ─────────────

export async function getSubscriptionView(db: PrismaClient, ctx: TenantContext, now?: Date) {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const at = now ?? (await dbNow(db));
  const [seller, plan, payments] = await Promise.all([
    db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { trialEndsAt: true, subscription: { include: { plan: true } } } }),
    db.subscriptionPlan.findUnique({ where: { code: DEFAULT_PLAN_CODE } }),
    db.subscriptionPayment.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { createdAt: "desc" }, take: 24 }),
  ]);
  const sub = seller.subscription;
  const shownPlan = sub?.plan ?? plan;
  return {
    access: sellerAccess({ trialEndsAt: seller.trialEndsAt, subscription: sub }, at),
    trialEndsAt: seller.trialEndsAt,
    plan: shownPlan ? { name: shownPlan.name, listPrice: shownPlan.listPrice, salePrice: shownPlan.salePrice } : null,
    subscription: sub
      ? {
          status: sub.status,
          cardLabel: sub.cardLabel,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          nextChargeAt: sub.nextChargeAt,
          graceUntil: sub.graceUntil,
          retryCount: sub.retryCount,
        }
      : null,
    payments: payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      paidAt: p.paidAt,
      receiptUrl: p.receiptUrl,
      createdAt: p.createdAt,
    })),
  };
}

// ───────────── 카드 등록(구독 시작·카드 변경) ─────────────

export type SubscribeResult =
  | { ok: true; charged: boolean; currentPeriodEnd: Date | null; nextChargeAt: Date | null }
  | { ok: false; reason: "card_rejected" | "plan_missing" | "payment_in_progress" | "payment_failed" };

// 카드를 등록(또는 교체)한다.
// - 결제한 기간이 남아 있고 자동결제가 정상이면 카드만 바꾼다.
// - 체험하기 중이면 카드만 등록하고 첫 결제를 체험하기 종료 시각으로 예약한다.
// - 그 밖(체험하기 끝, 결제 대기, 자동결제 실패 유예, 잠김)이면 바로 결제한다.
//   예약 결제 대기·유예 중이면 원래 시작해야 했던 기간을, 잠긴 뒤면 지금부터 한 달을 결제한다.
export async function registerCardAndPay(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { authKey: string; now?: Date },
): Promise<SubscribeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const issued = await provider.issueBillingKey({ authKey: input.authKey, customerKey: ctx.sellerId });
  if (!issued.ok) {
    await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "subscription.card_rejected" });
    return { ok: false, reason: "card_rejected" };
  }
  const billingKeyCipher = sealBillingKey(issued.billingKey);

  type Prepared =
    | { kind: "card_only"; end: Date | null; nextChargeAt: Date | null }
    | { kind: "charge"; payment: SubscriptionPayment; orderName: string }
    | { kind: "error"; reason: "plan_missing" | "payment_in_progress" };
  const prepared = await db.$transaction(async (tx): Promise<Prepared> => {
    await lockSeller(tx, ctx.sellerId);
    const now = input.now ?? (await dbNow(tx));
    const seller = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { trialEndsAt: true, subscription: true } });
    const before = seller.subscription;
    const accessBefore = sellerAccess({ trialEndsAt: seller.trialEndsAt, subscription: before }, now);
    const plan = before
      ? await tx.subscriptionPlan.findUnique({ where: { id: before.planId } })
      : await tx.subscriptionPlan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
    if (!plan) return { kind: "error", reason: "plan_missing" };

    const inTrial = !!seller.trialEndsAt && seller.trialEndsAt > now;
    const paidActive = before?.status === "ACTIVE" && !!before.currentPeriodEnd && before.currentPeriodEnd > now;
    const cardOnly = paidActive || (inTrial && before?.status !== "PAST_DUE");
    // 카드를 다시 등록하면 자동결제를 다시 켠다. 해지된 구독도 다시 시작한다.
    const nextChargeAt = paidActive ? after(before!.currentPeriodEnd!, -RENEW_LEAD_MS) : inTrial && cardOnly ? seller.trialEndsAt : null;
    const card = { billingKeyCipher, cardLabel: issued.cardLabel, cancelAtPeriodEnd: false };
    const sub = await tx.sellerSubscription.upsert({
      where: { sellerId: ctx.sellerId },
      create: { sellerId: ctx.sellerId, planId: plan.id, ...card, nextChargeAt },
      update: cardOnly ? { ...card, status: "ACTIVE", nextChargeAt } : card,
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "subscription.card_registered",
      targetType: "SellerSubscription",
      targetId: sub.id,
      after: { cardLabel: issued.cardLabel, chargeNow: !cardOnly },
    });
    if (cardOnly) return { kind: "card_only", end: sub.currentPeriodEnd, nextChargeAt };

    const pending = await tx.subscriptionPayment.findFirst({ where: { subscriptionId: sub.id, status: "PENDING" } });
    if (pending) return { kind: "error", reason: "payment_in_progress" };
    // 결제 대기·유예 중이면 원래 시작했어야 할 기간(이미 그 기간을 쓰고 있음), 잠긴 뒤면 지금부터.
    const owed = before?.currentPeriodEnd ?? seller.trialEndsAt ?? now;
    const start = (accessBefore === "charging" || accessBefore === "grace") && owed <= now ? owed : now;
    const payment = await tx.subscriptionPayment.create({
      data: { sellerId: ctx.sellerId, subscriptionId: sub.id, amount: plan.salePrice, periodStart: start, periodEnd: addOneMonth(start) },
    });
    return { kind: "charge", payment, orderName: plan.name };
  });

  if (prepared.kind === "error") return { ok: false, reason: prepared.reason };
  if (prepared.kind === "card_only") return { ok: true, charged: false, currentPeriodEnd: prepared.end, nextChargeAt: prepared.nextChargeAt };

  const result = await provider.charge({
    billingKey: issued.billingKey,
    customerKey: ctx.sellerId,
    amount: prepared.payment.amount,
    orderId: prepared.payment.id,
    orderName: prepared.orderName,
  });
  const settled = await settlePayment(db, prepared.payment, result, { scheduled: false, actorType: ctx.actorType, actorId: ctx.actorId, now: input.now });
  return result.ok ? { ok: true, charged: true, currentPeriodEnd: prepared.payment.periodEnd, nextChargeAt: settled.nextChargeAt } : { ok: false, reason: "payment_failed" };
}

// 결제 결과를 청구·구독에 반영한다.
// 성공: 이용 기간을 그 청구 기간으로, 다음 결제를 기간 끝 하루 전으로, 재시도·유예를 지운다.
// 예약 결제 실패: 처음 실패면 PAST_DUE + 유예(지금 + 7일), 이후 실패마다 재시도 횟수를 올리고 3번을 넘기면 더 시도하지 않는다.
// 판매자가 직접 한 결제(카드 등록)가 실패하면 구독 상태는 그대로 둔다.
async function settlePayment(
  db: PrismaClient,
  payment: SubscriptionPayment,
  result: ChargeResult,
  opts: { scheduled: boolean; actorType: ActorType; actorId: string | null; now?: Date },
): Promise<{ nextChargeAt: Date | null }> {
  return db.$transaction(async (tx) => {
    await lockSeller(tx, payment.sellerId);
    const now = opts.now ?? (await dbNow(tx));
    let nextChargeAt: Date | null = null;
    if (result.ok) {
      nextChargeAt = after(payment.periodEnd, -RENEW_LEAD_MS);
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: now, providerPaymentId: result.paymentId, receiptUrl: result.receiptUrl },
      });
      await tx.sellerSubscription.update({
        where: { id: payment.subscriptionId },
        data: {
          status: "ACTIVE",
          currentPeriodStart: payment.periodStart,
          currentPeriodEnd: payment.periodEnd,
          nextChargeAt,
          retryCount: 0,
          graceUntil: null,
        },
      });
    } else {
      await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: result.reason.slice(0, 200) } });
      const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id: payment.subscriptionId } });
      if (opts.scheduled) {
        if (sub.status !== "PAST_DUE") {
          nextChargeAt = after(now, RETRY_INTERVAL_MS);
          await tx.sellerSubscription.update({
            where: { id: sub.id },
            data: { status: "PAST_DUE", retryCount: 0, graceUntil: after(now, GRACE_MS), nextChargeAt },
          });
        } else {
          const retryCount = Math.min(sub.retryCount + 1, MAX_RETRIES);
          nextChargeAt = retryCount >= MAX_RETRIES ? null : after(now, RETRY_INTERVAL_MS);
          await tx.sellerSubscription.update({ where: { id: sub.id }, data: { retryCount, nextChargeAt } });
        }
      } else {
        nextChargeAt = sub.nextChargeAt;
      }
    }
    await writeAudit(tx, {
      actorType: opts.actorType,
      actorId: opts.actorId,
      sellerId: payment.sellerId,
      action: result.ok ? "subscription.payment_paid" : "subscription.payment_failed",
      targetType: "SubscriptionPayment",
      targetId: payment.id,
      after: { amount: payment.amount, scheduled: opts.scheduled },
      reason: result.ok ? undefined : result.reason.slice(0, 200),
    });
    return { nextChargeAt };
  });
}

// ───────────── 해지 ─────────────

// 결제한 기간이 남아 있으면 그 기간 끝까지 쓰고 다음 결제를 하지 않는다(즉시 환불 없음).
// 결제한 기간이 없으면(체험하기 중 카드만 등록, 자동결제 실패 유예 중) 바로 해지하고 청구하지 않는다.
export async function cancelSubscription(db: PrismaClient, ctx: TenantContext, input: { now?: Date } = {}) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const now = input.now ?? (await dbNow(tx));
    const sub = await tx.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId } });
    if (!sub || sub.status === "CANCELED" || sub.cancelAtPeriodEnd) return { ok: false as const, reason: "not_subscribed" as const };
    const paidThrough = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : null;
    await tx.sellerSubscription.update({
      where: { id: sub.id },
      data: paidThrough
        ? { cancelAtPeriodEnd: true, nextChargeAt: paidThrough }
        : { cancelAtPeriodEnd: true, status: "CANCELED", nextChargeAt: null, graceUntil: null },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "subscription.cancel",
      targetType: "SellerSubscription",
      targetId: sub.id,
      after: { endsAt: paidThrough, immediate: !paidThrough },
    });
    return { ok: true as const, currentPeriodEnd: paidThrough };
  });
}

// ───────────── 예약 실행 (첫 결제·다음 달 결제·재시도·해지 처리) ─────────────

export type RenewSummary = { charged: number; failed: number; canceled: number; skipped: number };

// nextChargeAt이 지난 구독을 처리한다. 예약 실행(인프라 승인 후 연결)에서 주기적으로 부른다.
// 같은 기간 청구는 부분 유니크 인덱스로 한 번만 만들어지므로 여러 번·동시에 돌려도 이중 결제되지 않는다.
export async function renewDueSubscriptions(db: PrismaClient, provider: BillingProvider, input: { now?: Date } = {}): Promise<RenewSummary> {
  const now = input.now ?? (await dbNow(db));
  const summary: RenewSummary = { charged: 0, failed: 0, canceled: 0, skipped: 0 };
  const due = await db.sellerSubscription.findMany({
    where: { status: { in: ["ACTIVE", "PAST_DUE"] }, nextChargeAt: { lte: now } },
    select: { id: true, sellerId: true },
  });

  for (const { id, sellerId } of due) {
    const prepared = await db
      .$transaction(async (tx) => {
        await lockSeller(tx, sellerId);
        // 잠근 뒤 다시 읽는다(그사이 결제·해지·카드 교체가 있었을 수 있음).
        const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id }, include: { plan: true, seller: { select: { trialEndsAt: true } } } });
        if (sub.status === "CANCELED" || !sub.nextChargeAt || sub.nextChargeAt > now) return null;
        if (sub.cancelAtPeriodEnd) {
          if (sub.currentPeriodEnd && sub.currentPeriodEnd > now) return null;
          await tx.sellerSubscription.update({ where: { id }, data: { status: "CANCELED", nextChargeAt: null } });
          await writeAudit(tx, { actorType: "SYSTEM", sellerId, action: "subscription.canceled", targetType: "SellerSubscription", targetId: id });
          return "canceled" as const;
        }
        if (!sub.billingKeyCipher) return null;
        const start = sub.currentPeriodEnd ?? sub.seller.trialEndsAt ?? now;
        const payment = await tx.subscriptionPayment.create({
          data: { sellerId, subscriptionId: id, amount: sub.plan.salePrice, periodStart: start, periodEnd: addOneMonth(start) },
        });
        return { payment, billingKey: openBillingKey(sub.billingKeyCipher), orderName: sub.plan.name };
      })
      .catch((e) => {
        if (isUniqueViolation(e)) return null; // 같은 기간 청구가 이미 진행 중이거나 결제됨
        throw e;
      });

    if (prepared === null) {
      summary.skipped++;
      continue;
    }
    if (prepared === "canceled") {
      summary.canceled++;
      continue;
    }
    const result = await provider.charge({
      billingKey: prepared.billingKey,
      customerKey: sellerId,
      amount: prepared.payment.amount,
      orderId: prepared.payment.id,
      orderName: prepared.orderName,
    });
    await settlePayment(db, prepared.payment, result, { scheduled: true, actorType: "SYSTEM", actorId: null, now: input.now });
    if (result.ok) summary.charged++;
    else summary.failed++;
  }
  return summary;
}
