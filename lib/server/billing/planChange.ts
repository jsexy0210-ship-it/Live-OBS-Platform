import type { PrismaClient, SubscriptionPayment } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { addMonthsKst } from "./access";
import type { BillingProvider, ChargeResult } from "./provider";
import { openBillingKey } from "./secret";
import { chargeFor, dbNow, isEndedSubscription, lockSeller, planPeriod, priceFor, sellerPlanOf, settlePayment, switchPlan } from "./subscription";

// 플랜 변경(ONQ 1-C-2, ARCHITECTURE 4.8.0 「결제 규칙」, PRODUCT_SCOPE 확정 ①). 실제 PG는 공급자 인터페이스로만 부른다.
// - 상위 변경(오버레이 전용 → 통합)은 결제사가 결제를 확정한 뒤에만 적용한다. 대기·실패·시간 초과면 지금 플랜 그대로다.
//   · 결제한 기간 중: 차액 = (새 플랜 금액 − 지금 플랜 금액) × 남은 일수 ÷ 이번 기간 일수(KST 날짜), 원 단위 절사. 결제일은 그대로(PRORATION 청구).
//   · 체험 중: 체험을 끝내고 새 플랜 금액을 바로 결제, 결제일을 그날로 새로 잡는다(기간 결제, 확정 때 체험 끝).
//   · 결제 실패 유예 중(PAST_DUE): 밀린 기간의 지금 플랜 금액 + 그 기간 남은 일수의 차액을 한 청구로 결제해 확정된 뒤에만 연다.
//   · 그 밖(잠김·해지·결제한 기간 없음): 결제 없이 플랜만 바꾼다(다음 결제가 새 플랜 금액, 결제 전에는 잠금 규칙이 막음).
//   · 카드가 없으면 결제할 수 없는 경우(체험 중·유예 중) card_required. 체험 중 결제 없이 통합을 열지 않는다.
// - 하위 변경(통합 → 오버레이 전용): 결제한 기간이나 유예 중이면 다음 결제일부터(pendingPlanId), 아니면 바로. 환불 없음.
//   변경 전에 받은 주문의 처리는 그대로 열린다(기능 권한 ORDER_FOLLOWUP).
// - 사업자·통신판매업 점검 게이트는 오버레이 전용 최소 가입(ONQ 2단계)이 생길 때 넣는다(지금은 모든 가입이 점검을 거침).
// - 런칭 할인 계정당 1회(대표님 결정 2026-10-04): 구독이 이어지는 동안의 상위 변경은 런칭가 기준이고, 정가 구독은 정가 기준이다.

export const CHANGEABLE_PLANS = ["OVERLAY_ONLY", "INTEGRATED"] as const;
const RANK: Record<string, number> = { OVERLAY_ONLY: 1, INTEGRATED: 2, STANDARD: 2 };

export type PlanChangeFailure =
  | "invalid_plan"
  | "same_plan"
  | "card_required"
  | "payment_in_progress"
  | "payment_failed"
  | "payment_pending"
  | "plan_missing";

export type PlanChangeResult =
  // remainingDays: 차액을 낸 경우 남은 일수(KST 날짜, 화면 「남은 N일분 차액」)
  | { ok: true; applied: "now" | "next_payment" | "canceled_pending"; charged: number; planCode: string; effectiveAt: Date | null; remainingDays?: number | null }
  | { ok: false; reason: PlanChangeFailure };

export const PLAN_CHANGE_STATUS: Record<PlanChangeFailure, number> = {
  invalid_plan: 400,
  same_plan: 409,
  card_required: 409,
  payment_in_progress: 409,
  payment_failed: 402,
  payment_pending: 202,
  plan_missing: 409,
};

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;
const kstDay = (d: Date) => Math.floor((d.getTime() + KST_MS) / DAY_MS);

// 남은 기간 차액(MASTER 결정 2026-10-04: KST 달력 일 단위). 남은 일수 = 기간 끝 날짜 − 오늘 날짜(KST), 기간 일수 = 끝 날짜 − 시작 날짜.
// 결제일(기간 끝 날짜) 당일은 0일, 그 전날은 1일. 원 단위 절사.
export function proration(diff: number, start: Date, end: Date, now: Date): { amount: number; remainingDays: number } {
  const total = Math.max(1, kstDay(end) - kstDay(start));
  const remainingDays = Math.min(total, Math.max(0, kstDay(end) - kstDay(now)));
  return { amount: Math.floor((Math.max(0, diff) * remainingDays) / total), remainingDays };
}

type Prepared =
  | { kind: "done"; result: PlanChangeResult }
  | { kind: "charge"; payment: SubscriptionPayment; billingKey: string; orderName: string; planCode: string; remainingDays: number | null };

export async function changePlan(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { planCode: unknown; now?: Date },
): Promise<PlanChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const code = typeof input.planCode === "string" ? input.planCode : "";
  if (!(CHANGEABLE_PLANS as readonly string[]).includes(code)) return { ok: false, reason: "invalid_plan" };

  const prepared = await db.$transaction(async (tx): Promise<Prepared> => {
    await lockSeller(tx, ctx.sellerId);
    const now = input.now ?? (await dbNow(tx));
    const target = await tx.subscriptionPlan.findUnique({ where: { code } });
    if (!target) return { kind: "done", result: { ok: false, reason: "plan_missing" } };
    const seller = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { trialEndsAt: true } });
    const sub = await tx.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, include: { plan: true } });
    const current = sub?.plan ?? (await sellerPlanOf(tx, ctx.sellerId));
    if (!current) return { kind: "done", result: { ok: false, reason: "plan_missing" } };
    const audit = (action: string, after: Record<string, unknown>) =>
      writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action,
        targetType: "SellerSubscription",
        targetId: sub?.id ?? ctx.sellerId,
        before: { planCode: current.code, pendingPlanId: sub?.pendingPlanId ?? null },
        after,
      });

    if (current.id === target.id) {
      // 예약된 하위 변경을 거두고 지금 플랜을 그대로 쓴다
      if (sub?.pendingPlanId) {
        await tx.sellerSubscription.update({ where: { id: sub.id }, data: { pendingPlanId: null } });
        await audit("subscription.plan_change_canceled", { planCode: current.code });
        return { kind: "done", result: { ok: true, applied: "canceled_pending", charged: 0, planCode: current.code, effectiveAt: null } };
      }
      return { kind: "done", result: { ok: false, reason: "same_plan" } };
    }
    if (sub && (await tx.subscriptionPayment.findFirst({ where: { subscriptionId: sub.id, status: "PENDING" }, select: { id: true } }))) {
      return { kind: "done", result: { ok: false, reason: "payment_in_progress" } };
    }

    const active = !!sub && !isEndedSubscription(sub, now);
    const paidActive = active && sub!.status === "ACTIVE" && !!sub!.currentPeriodEnd && sub!.currentPeriodEnd > now && !!sub!.currentPeriodStart;
    const pastDue = active && sub!.status === "PAST_DUE";
    const inTrial = !!seller.trialEndsAt && seller.trialEndsAt > now && !paidActive;
    const now0 = { kind: "done" as const, result: { ok: true as const, applied: "now" as const, charged: 0, planCode: target.code, effectiveAt: now } };

    // 하위 변경: 결제한 기간·유예 중이면 다음 결제일부터, 아니면 바로
    if (RANK[target.code] < RANK[current.code]) {
      if (paidActive || pastDue) {
        await tx.sellerSubscription.update({ where: { id: sub!.id }, data: { pendingPlanId: target.id } });
        const effectiveAt = sub!.nextChargeAt ?? sub!.currentPeriodEnd;
        await audit("subscription.plan_downgrade_scheduled", { planCode: target.code, effectiveAt });
        return { kind: "done", result: { ok: true, applied: "next_payment", charged: 0, planCode: target.code, effectiveAt } };
      }
      await switchPlan(tx, sub?.id ?? null, ctx.sellerId, target.id);
      await audit("subscription.plan_downgraded", { planCode: target.code });
      return now0;
    }

    // 상위 변경
    if (!paidActive && !pastDue && !inTrial) {
      // 결제한 기간도 체험도 없다(잠김·해지·첫 결제 전): 플랜만 바꾸고 다음 결제가 새 플랜 금액이다
      await switchPlan(tx, sub?.id ?? null, ctx.sellerId, target.id);
      await audit("subscription.plan_upgraded", { planCode: target.code, charged: 0 });
      return now0;
    }
    if (!sub?.billingKeyCipher) return { kind: "done", result: { ok: false, reason: "card_required" } };
    const billingKey = openBillingKey(sub.billingKeyCipher, ctx.sellerId);
    // 금액: 정가 구독이면 두 플랜 모두 정가, 아니면 판매가(런칭가). 구독이 이어지는 동안의 상위 변경은 런칭가를 유지한다(대표님 결정 2026-10-04).
    const cur = await chargeFor(tx, current, sub, now);
    const curPrice = cur.amount;
    const newPrice = sub.regularPrice ? target.listPrice : await priceFor(tx, target, sub.subscribedAt, now);
    const base = { sellerId: ctx.sellerId, subscriptionId: sub.id, scheduled: false, targetPlanId: target.id, createdAt: now, launchDiscount: !sub.regularPrice };

    let payment: SubscriptionPayment;
    let remainingDays: number | null = null;
    if (paidActive) {
      const { amount, remainingDays: days } = proration(newPrice - curPrice, sub.currentPeriodStart!, sub.currentPeriodEnd!, now);
      remainingDays = days;
      if (amount <= 0) {
        await switchPlan(tx, sub.id, ctx.sellerId, target.id);
        await audit("subscription.plan_upgraded", { planCode: target.code, charged: 0 });
        return now0;
      }
      payment = await tx.subscriptionPayment.create({
        data: { ...base, kind: "PRORATION", amount, periodStart: sub.currentPeriodStart!, periodEnd: sub.currentPeriodEnd! },
      });
    } else if (pastDue) {
      const period = planPeriod(sub, now);
      if (sub.billingAnchorAt?.getTime() !== period.anchor.getTime()) {
        await tx.sellerSubscription.update({ where: { id: sub.id }, data: { billingAnchorAt: period.anchor } });
      }
      const diff = proration(newPrice - curPrice, period.start, period.end, now);
      remainingDays = diff.remainingDays;
      const amount = curPrice + diff.amount;
      payment = await tx.subscriptionPayment.create({ data: { ...base, kind: "PERIOD", amount, periodStart: period.start, periodEnd: period.end } });
    } else {
      // 체험 중: 새 플랜 금액을 바로, 결제일은 그날로 새로
      const end = addMonthsKst(now, 1);
      await tx.sellerSubscription.update({ where: { id: sub.id }, data: { billingAnchorAt: now } });
      payment = await tx.subscriptionPayment.create({ data: { ...base, kind: "PERIOD", amount: newPrice, periodStart: now, periodEnd: end } });
    }
    await audit("subscription.plan_upgrade_requested", { planCode: target.code, amount: payment.amount, kind: payment.kind });
    return { kind: "charge", payment, billingKey, orderName: `${target.name} 변경`, planCode: target.code, remainingDays };
  });

  if (prepared.kind === "done") return prepared.result;
  let result: ChargeResult;
  try {
    result = await provider.charge({
      billingKey: prepared.billingKey,
      customerKey: ctx.sellerId,
      amount: prepared.payment.amount,
      orderId: prepared.payment.id,
      orderName: prepared.orderName,
    });
  } catch {
    // 결제됐는지 알 수 없다. PENDING으로 두고 정리 함수(reconcileStalePayments)가 확정한다. 그 전에는 지금 플랜 그대로다.
    return { ok: false, reason: "payment_pending" };
  }
  await settlePayment(db, prepared.payment.id, result, { actorType: ctx.actorType, actorId: ctx.actorId, now: input.now });
  if (!result.ok) return { ok: false, reason: "payment_failed" };
  const now = input.now ?? (await dbNow(db));
  return { ok: true, applied: "now", charged: prepared.payment.amount, planCode: prepared.planCode, effectiveAt: now, remainingDays: prepared.remainingDays };
}
