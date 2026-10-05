import type { Prisma, PrismaClient, SubscriptionPayment, SubscriptionPlan } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { addMonthsKst, isCancelScheduled, isEndedSubscription, planChangeState } from "./access";
import type { BillingProvider, ChargeResult } from "./provider";
import { openBillingKey } from "./secret";
import { chargeFor, dbNow, type PriceSubscription, lockSeller, planPeriod, sellerPlanOf, withoutLegacy, settlePayment, switchPlan } from "./subscription";

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
  | "not_activated" // 결제는 됐지만 그사이 해지 등으로 반영되지 않음(환불 대상으로 감사 기록)
  | "plan_missing"
  | "amount_required" // 확인 금액(expectedAmount)이 꼭 필요한 호출(HTTP 경로)인데 없음. 다른 실패 사유가 먼저다
  | "amount_changed" // 확인받은 금액(expectedAmount)과 지금 낼 금액이 다름(아무것도 바꾸지 않음)
  | "cancel_scheduled"; // 해지 예약 중(바꿔도 해지로 끝나 적용되지 않음). 카드를 다시 등록해 해지를 취소한 뒤 바꾼다

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
  not_activated: 409,
  plan_missing: 409,
  cancel_scheduled: 409,
  amount_changed: 409,
  amount_required: 400,
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

// 플랜 변경 판단(쓰기 없음). 실제 변경(changePlan)과 미리보기(previewPlanChanges)가 같은 판단을 쓴다.
// 잠금은 부르는 쪽이 정한다(changePlan은 판매자 행을 잠근 트랜잭션 안에서 부른다).
export type PlanChangeQuote =
  | { type: "fail"; reason: PlanChangeFailure }
  | { type: "cancel_pending" }
  | { type: "schedule"; effectiveAt: Date | null }
  | { type: "switch"; direction: "down" | "up" }
  | {
      type: "charge";
      kind: "PERIOD" | "PRORATION";
      amount: number;
      periodStart: Date;
      periodEnd: Date;
      remainingDays: number | null;
      launchDiscount: boolean;
      // 결제일을 새로 잡을 때(체험 중 = 지금, 유예 중 = 밀린 기간의 기준일이 바뀐 경우)
      newAnchor: Date | null;
    };

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
type Sub = Prisma.SellerSubscriptionGetPayload<{ include: { plan: true } }>;

export async function quotePlanChange(
  tx: Tx,
  input: { trialEndsAt: Date | null; sub: Sub | null; current: SubscriptionPlan; target: SubscriptionPlan; now: Date },
): Promise<PlanChangeQuote> {
  const { sub, current, target, now } = input;
  if (isCancelScheduled(sub, now)) return { type: "fail", reason: "cancel_scheduled" };
  if (current.id === target.id) return sub?.pendingPlanId ? { type: "cancel_pending" } : { type: "fail", reason: "same_plan" };
  if (sub && (await tx.subscriptionPayment.findFirst({ where: { subscriptionId: sub.id, status: "PENDING" }, select: { id: true } }))) {
    return { type: "fail", reason: "payment_in_progress" };
  }
  const { paidActive, pastDue, inTrial } = planChangeState(input.trialEndsAt, sub, now);

  // 하위 변경: 결제한 기간·유예 중이면 다음 결제일부터, 아니면 바로
  if (RANK[target.code] < RANK[current.code]) {
    if (paidActive || pastDue) return { type: "schedule", effectiveAt: sub!.nextChargeAt ?? sub!.currentPeriodEnd };
    return { type: "switch", direction: "down" };
  }
  // 상위 변경. 결제한 기간도 체험도 없다(잠김·해지·첫 결제 전): 플랜만 바꾸고 다음 결제가 새 플랜 금액이다
  if (!paidActive && !pastDue && !inTrial) return { type: "switch", direction: "up" };
  if (!sub?.billingKeyCipher) return { type: "fail", reason: "card_required" };
  // 금액: 정가 구독이면 두 플랜 모두 정가, 아니면 판매가(런칭가). 구독이 이어지는 동안의 상위 변경은 런칭가를 유지한다(대표님 결정 2026-10-04).
  // 두 금액 모두 chargeFor(가격 기록·고지 규칙)로 정한다. 새 플랜은 옮기면 스냅숏이 끝나므로 스냅숏 없이 센다.
  const curPrice = (await chargeFor(tx, current, sub, now)).amount;
  const next = await chargeFor(tx, target, withoutLegacy(sub), now);
  const newPrice = next.amount;
  if (paidActive) {
    const { amount, remainingDays } = proration(newPrice - curPrice, sub.currentPeriodStart!, sub.currentPeriodEnd!, now);
    if (amount <= 0) return { type: "switch", direction: "up" };
    return { type: "charge", kind: "PRORATION", amount, periodStart: sub.currentPeriodStart!, periodEnd: sub.currentPeriodEnd!, remainingDays, launchDiscount: next.launchDiscount, newAnchor: null };
  }
  if (pastDue) {
    const period = planPeriod(sub, now);
    const diff = proration(newPrice - curPrice, period.start, period.end, now);
    return {
      type: "charge",
      kind: "PERIOD",
      amount: curPrice + diff.amount,
      periodStart: period.start,
      periodEnd: period.end,
      remainingDays: diff.remainingDays,
      launchDiscount: next.launchDiscount,
      newAnchor: sub.billingAnchorAt?.getTime() !== period.anchor.getTime() ? period.anchor : null,
    };
  }
  // 체험 중: 새 플랜 금액을 바로, 결제일은 그날로 새로
  return { type: "charge", kind: "PERIOD", amount: newPrice, periodStart: now, periodEnd: addMonthsKst(now, 1), remainingDays: null, launchDiscount: next.launchDiscount, newAnchor: now };
}

type Prepared =
  | { kind: "done"; result: PlanChangeResult }
  | { kind: "charge"; payment: SubscriptionPayment; billingKey: string; orderName: string; planCode: string; remainingDays: number | null };

export async function changePlan(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  // requireExpectedAmount: HTTP 경로는 확인 금액을 꼭 받는다(화면은 미리보기 chargeNow를 보냄, #253). 판단 실패 사유가 먼저고, 그다음 없으면 amount_required
  input: { planCode: unknown; expectedAmount?: number; requireExpectedAmount?: boolean; now?: Date },
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
    const now0 = { kind: "done" as const, result: { ok: true as const, applied: "now" as const, charged: 0, planCode: target.code, effectiveAt: now } };

    const q = await quotePlanChange(tx, { trialEndsAt: seller.trialEndsAt, sub, current, target, now });
    // 화면에서 확인받은 금액(미리보기 chargeNow)이 있으면 지금 낼 금액과 같을 때만 진행한다(그사이 날짜·가격이 바뀌면 409, 아무것도 바꾸지 않음)
    // 예약 취소(cancel_pending)는 결제가 없어 확인할 금액이 없다: 화면의 「변경 취소」는 금액 없이 보내므로 필수 검사에서 뺀다(보내면 0과 같을 때만)
    if (q.type !== "fail" && q.type !== "cancel_pending" && input.expectedAmount === undefined && input.requireExpectedAmount) return { kind: "done", result: { ok: false, reason: "amount_required" } };
    if (q.type !== "fail" && input.expectedAmount !== undefined && input.expectedAmount !== (q.type === "charge" ? q.amount : 0)) {
      return { kind: "done", result: { ok: false, reason: "amount_changed" } };
    }
    switch (q.type) {
      case "fail":
        return { kind: "done", result: { ok: false, reason: q.reason } };
      case "cancel_pending":
        // 예약된 하위 변경을 거두고 지금 플랜을 그대로 쓴다
        await tx.sellerSubscription.update({ where: { id: sub!.id }, data: { pendingPlanId: null } });
        await audit("subscription.plan_change_canceled", { planCode: current.code });
        return { kind: "done", result: { ok: true, applied: "canceled_pending", charged: 0, planCode: current.code, effectiveAt: null } };
      case "schedule":
        await tx.sellerSubscription.update({ where: { id: sub!.id }, data: { pendingPlanId: target.id } });
        await audit("subscription.plan_downgrade_scheduled", { planCode: target.code, effectiveAt: q.effectiveAt });
        return { kind: "done", result: { ok: true, applied: "next_payment", charged: 0, planCode: target.code, effectiveAt: q.effectiveAt } };
      case "switch":
        await switchPlan(tx, sub?.id ?? null, ctx.sellerId, target.id);
        await audit(q.direction === "down" ? "subscription.plan_downgraded" : "subscription.plan_upgraded", q.direction === "down" ? { planCode: target.code } : { planCode: target.code, charged: 0 });
        return now0;
    }
    // 결제(card_required는 판단에서 걸렀으므로 카드가 있다)
    const billingKey = openBillingKey(sub!.billingKeyCipher!, ctx.sellerId);
    if (q.newAnchor) await tx.sellerSubscription.update({ where: { id: sub!.id }, data: { billingAnchorAt: q.newAnchor } });
    const payment = await tx.subscriptionPayment.create({
      data: {
        sellerId: ctx.sellerId,
        subscriptionId: sub!.id,
        scheduled: false,
        targetPlanId: target.id,
        createdAt: now,
        launchDiscount: q.launchDiscount,
        kind: q.kind,
        amount: q.amount,
        periodStart: q.periodStart,
        periodEnd: q.periodEnd,
      },
    });
    await audit("subscription.plan_upgrade_requested", { planCode: target.code, amount: payment.amount, kind: payment.kind });
    return { kind: "charge", payment, billingKey, orderName: `${target.name} 변경`, planCode: target.code, remainingDays: q.remainingDays };
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
  // 응답은 PG 결과가 아니라 반영된 뒤의 실제 구독으로 정한다(카드 등록과 같음, #186 Codex P1). 그사이 해지돼 정산이 환불 대상으로만
  // 남기고 플랜을 바꾸지 않았으면 성공이 아니다.
  const after = await db.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, select: { planId: true, status: true } });
  if (!after || after.status === "CANCELED" || after.planId !== prepared.payment.targetPlanId) return { ok: false, reason: "not_activated" };
  const now = input.now ?? (await dbNow(db));
  return { ok: true, applied: "now", charged: prepared.payment.amount, planCode: prepared.planCode, effectiveAt: now, remainingDays: prepared.remainingDays };
}

// 플랜별 금액·변경 미리보기(구독 화면 「플랜 바꾸기」). 쓰기 없이 changePlan과 같은 판단(quotePlanChange)을 쓴다.
// - price: 그 플랜으로 내는 다음 기간 결제 금액(지금 플랜은 지금 구독 기준, 다른 플랜은 바꾼 뒤 기준, chargeFor)
// - change: 지금 바꾸면 어떻게 되는지. 결제가 있으면 chargeNow(차액·체험 끝 결제·유예 중 밀린 금액 + 차액)와 remainingDays
//   실제 결제 금액은 바꾸는 순간의 가격·시각으로 다시 정한다(그사이 날짜가 바뀌면 남은 일수가 달라진다).
export type PlanChangePreview = {
  currentPlanCode: string | null;
  pendingPlanCode: string | null;
  plans: {
    planCode: string;
    name: string;
    current: boolean;
    price: number;
    change:
      | { ok: true; applied: "now" | "next_payment" | "canceled_pending"; chargeNow: number; remainingDays: number | null; effectiveAt: Date | null }
      | { ok: false; reason: PlanChangeFailure };
  }[];
};

export async function previewPlanChanges(db: PrismaClient, ctx: TenantContext, input: { now?: Date } = {}): Promise<PlanChangePreview> {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  return db.$transaction(async (tx) => {
    const now = input.now ?? (await dbNow(tx));
    const seller = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { trialEndsAt: true, launchDiscountUsedAt: true } });
    const sub = await tx.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId }, include: { plan: true, pendingPlan: true } });
    // 금액 기준은 구독 화면 다음 결제 금액(getSubscriptionView)과 같다: 이어지는 구독은 다음 결제일 가격, 아니면 지금 새로 구독할 때 가격
    const live = !!sub && !isEndedSubscription(sub, now);
    const fresh: PriceSubscription = { subscribedAt: now, legacyPrice: null, legacyPriceNoticeSentAt: null, regularPrice: !!seller.launchDiscountUsedAt };
    const current = sub?.plan ?? (await sellerPlanOf(tx, ctx.sellerId));
    const targets = await tx.subscriptionPlan.findMany({ where: { code: { in: [...CHANGEABLE_PLANS] } } });
    targets.sort((a, b) => CHANGEABLE_PLANS.indexOf(a.code as never) - CHANGEABLE_PLANS.indexOf(b.code as never));
    const plans: PlanChangePreview["plans"] = [];
    for (const target of targets) {
      const isCurrent = current?.id === target.id;
      const price = live
        ? (await chargeFor(tx, target, isCurrent ? sub! : withoutLegacy(sub!), sub!.nextChargeAt ?? now)).amount
        : (await chargeFor(tx, target, fresh, now)).amount;
      let change: PlanChangePreview["plans"][number]["change"];
      if (!current) change = { ok: false, reason: "plan_missing" };
      else {
        const q = await quotePlanChange(tx, { trialEndsAt: seller.trialEndsAt, sub, current, target, now });
        change =
          q.type === "fail"
            ? { ok: false, reason: q.reason }
            : q.type === "cancel_pending"
              ? { ok: true, applied: "canceled_pending", chargeNow: 0, remainingDays: null, effectiveAt: null }
              : q.type === "schedule"
                ? { ok: true, applied: "next_payment", chargeNow: 0, remainingDays: null, effectiveAt: q.effectiveAt }
                : q.type === "switch"
                  ? { ok: true, applied: "now", chargeNow: 0, remainingDays: null, effectiveAt: now }
                  : { ok: true, applied: "now", chargeNow: q.amount, remainingDays: q.remainingDays, effectiveAt: now };
      }
      plans.push({ planCode: target.code, name: target.name, current: isCurrent, price, change });
    }
    return { currentPlanCode: current?.code ?? null, pendingPlanCode: sub?.pendingPlan?.code ?? null, plans };
  });
}
