import { Prisma, type ActorType, type PrismaClient, type SubscriptionPayment } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { addOneMonth, sellerAccess, type SellerAccess } from "./access";
import type { BillingProvider, ChargeResult } from "./provider";
import { openBillingKey, sealBillingKey } from "./secret";

// 플랫폼 구독(판매자 → 플랫폼). 카드 자동결제(빌링키)만 쓰고 금액은 요금제의 판매가(부가세 포함)다.
// 실제 결제는 PG 공급자 인터페이스로만 하며, 이 저장소에는 가짜 공급자만 있다.

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

export const DEFAULT_PLAN_CODE = "STANDARD";
// 다음 달 결제는 기간이 끝나기 하루 전부터 한다(방송 중에 기간이 끊기지 않게).
export const RENEW_LEAD_MS = 24 * 60 * 60 * 1000;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

async function lockSeller(tx: Tx, sellerId: string) {
  await tx.$queryRaw`SELECT id FROM "Seller" WHERE id = ${sellerId}::uuid FOR UPDATE`;
}

export async function sellerAccessFor(db: Db, sellerId: string, now: Date): Promise<SellerAccess> {
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: { trialEndsAt: true, subscription: { select: { status: true, currentPeriodEnd: true } } },
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

// ───────────── 카드 등록·결제 ─────────────

export type SubscribeResult =
  | { ok: true; charged: boolean; currentPeriodEnd: Date | null }
  | { ok: false; reason: "card_rejected" | "plan_missing" | "payment_in_progress" | "payment_failed" };

// 카드를 등록(또는 교체)한다. 결제한 이용 기간이 없거나 자동결제가 실패해 있으면 바로 한 달 치를 결제한다.
// 무료 이용 중에 결제하면 남은 무료 기간 뒤부터 한 달이 시작된다.
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

  type Prepared = { kind: "paid"; end: Date | null } | { kind: "charge"; payment: SubscriptionPayment; orderName: string } | { kind: "error"; reason: "plan_missing" | "payment_in_progress" };
  const prepared = await db.$transaction(async (tx): Promise<Prepared> => {
    await lockSeller(tx, ctx.sellerId);
    const now = input.now ?? (await dbNow(tx));
    const seller = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { trialEndsAt: true, subscription: true } });
    const plan = seller.subscription
      ? await tx.subscriptionPlan.findUnique({ where: { id: seller.subscription.planId } })
      : await tx.subscriptionPlan.findUnique({ where: { code: DEFAULT_PLAN_CODE } });
    if (!plan) return { kind: "error", reason: "plan_missing" };

    const sub = await tx.sellerSubscription.upsert({
      where: { sellerId: ctx.sellerId },
      create: { sellerId: ctx.sellerId, planId: plan.id, billingKeyCipher, cardLabel: issued.cardLabel },
      // 카드를 다시 등록하면 자동결제를 다시 켠다.
      update: { billingKeyCipher, cardLabel: issued.cardLabel, cancelAtPeriodEnd: false },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "subscription.card_registered",
      targetType: "SellerSubscription",
      targetId: sub.id,
      after: { cardLabel: issued.cardLabel },
    });
    // 결제한 기간이 남아 있고 자동결제가 정상이면 카드만 바꾼다.
    const paidThrough = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : null;
    if (paidThrough && sub.status === "ACTIVE") return { kind: "paid", end: paidThrough };

    const pending = await tx.subscriptionPayment.findFirst({ where: { subscriptionId: sub.id, status: "PENDING" } });
    if (pending) return { kind: "error", reason: "payment_in_progress" };
    // 새 기간은 남은 무료 기간·남은 결제 기간(자동결제 실패로 미리 못 낸 경우) 뒤에 이어 붙인다.
    const start = [now, seller.trialEndsAt, paidThrough].reduce<Date>((a, b) => (b && b > a ? b : a), now);
    const payment = await tx.subscriptionPayment.create({
      data: { sellerId: ctx.sellerId, subscriptionId: sub.id, amount: plan.salePrice, periodStart: start, periodEnd: addOneMonth(start) },
    });
    return { kind: "charge", payment, orderName: plan.name };
  });

  if (prepared.kind === "error") return { ok: false, reason: prepared.reason };
  if (prepared.kind === "paid") return { ok: true, charged: false, currentPeriodEnd: prepared.end };

  const result = await provider.charge({
    billingKey: issued.billingKey,
    customerKey: ctx.sellerId,
    amount: prepared.payment.amount,
    orderId: prepared.payment.id,
    orderName: prepared.orderName,
  });
  await settlePayment(db, prepared.payment, result, { renewal: false, actorType: ctx.actorType, actorId: ctx.actorId });
  return result.ok ? { ok: true, charged: true, currentPeriodEnd: prepared.payment.periodEnd } : { ok: false, reason: "payment_failed" };
}

// 결제 결과를 청구·구독에 반영한다. 성공하면 이용 기간을 그 청구 기간으로 바꾼다.
// 자동결제(renewal)가 실패하면 구독을 PAST_DUE로 둔다(남은 기간이 끝나면 이용이 막힌다).
async function settlePayment(
  db: PrismaClient,
  payment: SubscriptionPayment,
  result: ChargeResult,
  opts: { renewal: boolean; actorType: ActorType; actorId: string | null },
) {
  await db.$transaction(async (tx) => {
    // 모든 구독 변경은 판매자 행을 먼저 잠근다(잠금 순서를 같게 해 교착을 막는다).
    await lockSeller(tx, payment.sellerId);
    const paidAt = await dbNow(tx);
    if (result.ok) {
      await tx.subscriptionPayment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt, providerPaymentId: result.paymentId, receiptUrl: result.receiptUrl },
      });
      await tx.sellerSubscription.update({
        where: { id: payment.subscriptionId },
        data: { status: "ACTIVE", currentPeriodStart: payment.periodStart, currentPeriodEnd: payment.periodEnd },
      });
    } else {
      await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: result.reason.slice(0, 200) } });
      if (opts.renewal) await tx.sellerSubscription.update({ where: { id: payment.subscriptionId }, data: { status: "PAST_DUE" } });
    }
    await writeAudit(tx, {
      actorType: opts.actorType,
      actorId: opts.actorId,
      sellerId: payment.sellerId,
      action: result.ok ? "subscription.payment_paid" : "subscription.payment_failed",
      targetType: "SubscriptionPayment",
      targetId: payment.id,
      after: { amount: payment.amount, renewal: opts.renewal },
      reason: result.ok ? undefined : result.reason.slice(0, 200),
    });
  });
}

// ───────────── 해지 ─────────────

// 해지하면 이번 이용 기간이 끝날 때까지 쓰고 다음 결제를 하지 않는다. 즉시 환불은 하지 않는다.
export async function cancelSubscription(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const sub = await db.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId } });
  if (!sub || sub.status !== "ACTIVE" || !sub.currentPeriodEnd) return { ok: false as const, reason: "not_subscribed" as const };
  await db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    await tx.sellerSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  });
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "subscription.cancel",
    targetType: "SellerSubscription",
    targetId: sub.id,
  });
  return { ok: true as const, currentPeriodEnd: sub.currentPeriodEnd };
}

// ───────────── 자동결제 (예약 작업에서 호출) ─────────────

export type RenewSummary = { charged: number; failed: number; canceled: number; skipped: number };

// 기간 끝이 다가온 구독을 결제한다. 해지 예약된 구독은 기간이 끝나면 CANCELED로 바꾼다.
// 같은 기간 청구는 부분 유니크 인덱스로 한 번만 만들어지므로 여러 번·동시에 돌려도 이중 결제되지 않는다.
export async function renewDueSubscriptions(db: PrismaClient, provider: BillingProvider, input: { now?: Date } = {}): Promise<RenewSummary> {
  const now = input.now ?? (await dbNow(db));
  const summary: RenewSummary = { charged: 0, failed: 0, canceled: 0, skipped: 0 };
  const due = await db.sellerSubscription.findMany({
    where: { status: "ACTIVE", currentPeriodEnd: { lte: new Date(now.getTime() + RENEW_LEAD_MS) } },
    select: { id: true },
  });

  for (const { id } of due) {
    const prepared = await db
      .$transaction(async (tx) => {
        const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id }, include: { plan: true } });
        await lockSeller(tx, sub.sellerId);
        // 잠근 뒤 다시 읽는다(그사이 결제·해지·카드 교체가 있었을 수 있음).
        const fresh = await tx.sellerSubscription.findUniqueOrThrow({ where: { id } });
        if (fresh.status !== "ACTIVE" || !fresh.currentPeriodEnd || fresh.currentPeriodEnd.getTime() > now.getTime() + RENEW_LEAD_MS) return null;
        if (fresh.cancelAtPeriodEnd) {
          if (fresh.currentPeriodEnd > now) return null;
          await tx.sellerSubscription.update({ where: { id }, data: { status: "CANCELED" } });
          await writeAudit(tx, { actorType: "SYSTEM", sellerId: fresh.sellerId, action: "subscription.canceled", targetType: "SellerSubscription", targetId: id });
          return "canceled" as const;
        }
        if (!fresh.billingKeyCipher) return null;
        const start = fresh.currentPeriodEnd;
        const payment = await tx.subscriptionPayment.create({
          data: { sellerId: fresh.sellerId, subscriptionId: id, amount: sub.plan.salePrice, periodStart: start, periodEnd: addOneMonth(start) },
        });
        return { payment, billingKey: openBillingKey(fresh.billingKeyCipher), orderName: sub.plan.name };
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
      customerKey: prepared.payment.sellerId,
      amount: prepared.payment.amount,
      orderId: prepared.payment.id,
      orderName: prepared.orderName,
    });
    await settlePayment(db, prepared.payment, result, { renewal: true, actorType: "SYSTEM", actorId: null });
    if (result.ok) summary.charged++;
    else summary.failed++;
  }
  return summary;
}
