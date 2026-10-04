import { Prisma, type ActorType, type PrismaClient, type SellerSubscription, type SubscriptionPayment, type SubscriptionPlan } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { addMonthsKst, lockedSince, nextPeriodEnd, sellerAccess, type SellerAccess } from "./access";
import type { BillingProvider, ChargeResult } from "./provider";
import { assertBillingSecret, openBillingKey, sealBillingKey } from "./secret";

// 플랫폼 구독(판매자 → 플랫폼). 카드 자동결제(빌링키)만 쓰고 금액은 요금제의 판매가(부가세 포함)다.
// 실제 결제는 PG 공급자 인터페이스로만 하며, 이 저장소에는 가짜 공급자만 있다.
// 결제 시점(MASTER·대표님 결정 2026-10-03):
// - 체험하기 중에 구독을 시작하면 카드만 등록하고, 첫 결제는 체험하기가 끝나는 시각에 예약 실행이 한다.
// - 다음 달 결제는 기간 끝 하루 전에 한다. 기간은 KST 기준일(첫 결제 시작)로 매달 같은 날(없으면 말일)까지.
// - 기간은 항상 원래 결제일(owed = 지난 기간 끝)에 이어서 센다. 잠겨서 못 쓴 날도 포함한다.
//   체험 뒤 첫 결제와 해지 뒤 다시 구독은 결제한 시각부터 센다.
// - 자동결제가 실패하면 하루 간격으로 3번 다시 시도하고, 실패한 때부터 7일 동안은 계속 쓸 수 있다(유예).
//   판매자가 카드를 바꾸면 바로 다시 결제한다.
// - 구독당 진행 중(PENDING) 청구는 하나뿐이다(DB 부분 유니크). PG 결과를 못 받은 청구는 reconcileStalePayments가 확정한다.

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

// 신규 가입 기본 플랜(ONQ 1-C, MASTER 결정 대기: A안 통합). 가입 신청에서 플랜을 고르지 않았거나(지금 화면) 판매자 플랜이 없으면 이 플랜이다.
// STANDARD는 이전 전 플랜이라 신규 가입에 쓰지 않는다.
export const DEFAULT_PLAN_CODE = "INTEGRATED";
const DAY_MS = 24 * 60 * 60 * 1000;
export const RENEW_LEAD_MS = DAY_MS;
export const RETRY_INTERVAL_MS = DAY_MS;
export const MAX_RETRIES = 3;
export const GRACE_MS = 7 * DAY_MS;
// 잠긴 지 이만큼 지나면 자동 해지(대표님 결정 2026-10-02). 해지 뒤 90일 보관·삭제는 별도 작업.
export const AUTO_CLOSE_AFTER_MS = 30 * DAY_MS;
// 가격 변경 뒤 기존 구독자에게 새 가격을 적용하기까지(대표님 결정 2026-10-02)
export const PRICE_NOTICE_MS = 30 * DAY_MS;
// PG 결과를 이만큼 못 받은 청구를 정리 대상으로 본다
export const STALE_PENDING_MS = 10 * 60 * 1000;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const after = (d: Date, ms: number) => new Date(d.getTime() + ms);

export async function dbNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

// 모든 구독 변경은 판매자 행을 먼저 잠근다(잠금 순서를 같게 해 교착을 막는다).
export async function lockSeller(tx: Tx, sellerId: string) {
  await tx.$queryRaw`SELECT id FROM "Seller" WHERE id = ${sellerId}::uuid FOR UPDATE`;
}

const ACCESS_SELECT = { status: true, currentPeriodEnd: true, nextChargeAt: true, graceUntil: true, cancelAtPeriodEnd: true } as const;

// 이용 가능 여부. now를 주지 않으면 DB 시계로 판단한다.
export async function sellerAccessFor(db: Db, sellerId: string, now?: Date): Promise<SellerAccess> {
  const at = now ?? (await dbNow(db));
  const seller = await db.seller.findUnique({
    where: { id: sellerId },
    select: { trialEndsAt: true, subscription: { select: ACCESS_SELECT } },
  });
  if (!seller) return "expired";
  return sellerAccess({ trialEndsAt: seller.trialEndsAt, subscription: seller.subscription }, at);
}

// 청구 금액의 유일한 출처(가격을 읽는 모든 경로가 이것만 쓴다, #186 Codex). 반환은 이번 청구 금액과 런칭가 여부다.
// 가격(정가·판매가)은 가격 기록 중 「구독을 시작할 때 이미 적용되던 것」이거나 「변경 + 30일이 지난 것」 가운데 가장 최근 것이다
// (대표님 결정 2026-10-02). 그래서 기존 구독자는 고지 기간(30일)이 끝나기 전에는 구독을 시작할 때의 가격(또는 그 뒤 고지가 끝난 가격)을
// 내고, 새 구독자는 지금 가격을 낸다. 정가 구독도 같은 규칙으로 정가를 고른다.
// - 정가 구독(regularPrice: 런칭 할인을 쓴 계정이 해지 뒤 다시 구독)은 정가(대표님 결정 2026-10-04, ARCHITECTURE 4.8.0).
// - 이전 전 가격 스냅숏(STANDARD → INTEGRATED, ONQ 1-C): 고지 발송 완료 + 30일 전이거나 아직 보내지 않았으면(null) 그 금액이다.
// - 그 밖은 판매가(= 런칭가). 스냅숏 금액과 STANDARD 플랜 결제는 런칭가로 세지 않는다.
// 아직 구독하지 않은 판매자는 subscribedAt = at(지금 가격), 스냅숏 없음으로 부른다.
export type PriceSubscription = Pick<SellerSubscription, "subscribedAt" | "legacyPrice" | "legacyPriceNoticeSentAt" | "regularPrice">;
export async function chargeFor(db: Db, plan: SubscriptionPlan, sub: PriceSubscription, at: Date): Promise<{ amount: number; launchDiscount: boolean }> {
  const legacy = !sub.regularPrice && sub.legacyPrice != null && (!sub.legacyPriceNoticeSentAt || at < after(sub.legacyPriceNoticeSentAt, PRICE_NOTICE_MS));
  if (legacy) return { amount: sub.legacyPrice!, launchDiscount: false };
  const row = await db.subscriptionPriceChange.findFirst({
    where: { planId: plan.id, OR: [{ changedAt: { lte: sub.subscribedAt } }, { changedAt: { lte: after(at, -PRICE_NOTICE_MS) } }] },
    orderBy: { changedAt: "desc" },
    select: { listPrice: true, salePrice: true },
  });
  const price = row ?? plan;
  if (sub.regularPrice) return { amount: price.listPrice, launchDiscount: false };
  // 이전 전 STANDARD 플랜 결제도 런칭 할인 사용으로 세지 않는다
  return { amount: price.salePrice, launchDiscount: plan.code !== "STANDARD" };
}

// 플랜을 옮긴 뒤(상위 변경·예약된 하위 변경) 청구 기준: 플랜이 바뀌면 이전 전 가격 스냅숏은 끝난다(switchPlan)
export const withoutLegacy = (sub: PriceSubscription): PriceSubscription => ({ ...sub, legacyPrice: null, legacyPriceNoticeSentAt: null });

// 구독 행이 없을 때 쓰는 판매자 플랜(가입 때 정한 플랜, 없으면 신규 가입 기본 플랜)
export async function sellerPlanOf(db: Db, sellerId: string): Promise<SubscriptionPlan | null> {
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { plan: true } });
  return seller?.plan ?? (await db.subscriptionPlan.findUnique({ where: { code: DEFAULT_PLAN_CODE } }));
}

type PeriodState = Pick<SellerSubscription, "status" | "currentPeriodEnd" | "billingAnchorAt" | "cancelAtPeriodEnd">;

// 해지된 구독인지: CANCELED이거나, 해지 예약한 기간이 이미 끝남(예약 실행이 아직 CANCELED로 바꾸기 전).
export function isEndedSubscription(sub: PeriodState | null, now: Date): boolean {
  if (!sub) return true;
  return sub.status === "CANCELED" || (sub.cancelAtPeriodEnd && !!sub.currentPeriodEnd && sub.currentPeriodEnd <= now);
}

// 다음 청구 기간. 결제한 적 있는 구독은 지난 기간 끝(owed)에 이어서, 처음이거나 해지 뒤면 지금부터(기준일 새로).
// owed부터 세도 기간이 이미 지났으면(잠금이 한 달을 넘김) 지금부터 새로 센다.
export function planPeriod(sub: PeriodState | null, now: Date) {
  if (sub && !isEndedSubscription(sub, now) && sub.currentPeriodEnd && sub.billingAnchorAt) {
    const end = nextPeriodEnd(sub.billingAnchorAt, sub.currentPeriodEnd);
    if (end > now) return { start: sub.currentPeriodEnd, end, anchor: sub.billingAnchorAt };
  }
  return { start: now, end: addMonthsKst(now, 1), anchor: now };
}

// ───────────── 조회 ─────────────

export async function getSubscriptionView(db: PrismaClient, ctx: TenantContext, now?: Date) {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const at = now ?? (await dbNow(db));
  const [seller, plan, payments] = await Promise.all([
    db.seller.findUniqueOrThrow({
      where: { id: ctx.sellerId },
      select: { trialEndsAt: true, launchDiscountUsedAt: true, subscription: { include: { plan: true, pendingPlan: true } } },
    }),
    sellerPlanOf(db, ctx.sellerId),
    db.subscriptionPayment.findMany({ where: { sellerId: ctx.sellerId }, orderBy: { createdAt: "desc" }, take: 24 }),
  ]);
  const sub = seller.subscription;
  const shownPlan = sub?.plan ?? plan;
  // 하위 변경이 예약돼 있으면 다음 결제는 그 플랜 금액이다(ONQ 1-C-2)
  const nextPlan = sub?.pendingPlan && !sub.cancelAtPeriodEnd ? sub.pendingPlan : shownPlan;
  return {
    access: sellerAccess({ trialEndsAt: seller.trialEndsAt, subscription: sub }, at),
    trialEndsAt: seller.trialEndsAt,
    plan: shownPlan
      ? {
          code: shownPlan.code,
          name: shownPlan.name,
          listPrice: shownPlan.listPrice,
          salePrice: shownPlan.salePrice,
          nextAmount:
            sub && !isEndedSubscription(sub, at)
              ? nextPlan === shownPlan
                ? (await chargeFor(db, shownPlan, sub, sub.nextChargeAt ?? at)).amount
                : (await chargeFor(db, nextPlan!, withoutLegacy(sub), sub.nextChargeAt ?? at)).amount
              : (await chargeFor(db, shownPlan, { subscribedAt: at, legacyPrice: null, legacyPriceNoticeSentAt: null, regularPrice: !!seller.launchDiscountUsedAt }, at))
                  .amount,
        }
      : null,
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
          // 다음 결제일에 바뀔 플랜(하위 변경 예약). 없으면 null
          pendingPlanCode: sub.pendingPlan?.code ?? null,
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
  | { ok: false; reason: "card_rejected" | "plan_missing" | "payment_in_progress" | "payment_failed" | "payment_pending" | "not_activated" };

// 카드를 등록(또는 교체)한다.
// - 결제한 기간이 남아 있고 자동결제가 정상이면 카드만 바꾼다.
// - 체험하기 중이면 카드만 등록하고 첫 결제를 체험하기 종료 시각으로 예약한다.
// - 그 밖(예약 결제 대기·유예·잠김)이면 바로 결제한다. 기간은 planPeriod 규칙대로.
// - PG 응답을 못 받으면(타임아웃) 청구를 PENDING으로 두고 payment_pending을 돌려준다(정리 함수가 확정).
export async function registerCardAndPay(
  db: PrismaClient,
  provider: BillingProvider,
  ctx: TenantContext,
  input: { authKey: string; now?: Date },
): Promise<SubscribeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  // 빌링키를 저장할 수 없으면 PG를 부르지 않는다
  assertBillingSecret();
  const issued = await provider.issueBillingKey({ authKey: input.authKey, customerKey: ctx.sellerId });
  if (!issued.ok) {
    await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "subscription.card_rejected" });
    return { ok: false, reason: "card_rejected" };
  }
  const billingKeyCipher = sealBillingKey(issued.billingKey, ctx.sellerId);

  type Prepared =
    | { kind: "card_only"; end: Date | null; nextChargeAt: Date | null }
    | { kind: "charge"; payment: SubscriptionPayment; orderName: string }
    | { kind: "error"; reason: "plan_missing" | "payment_in_progress" };
  const prepared = await db
    .$transaction(async (tx): Promise<Prepared> => {
      await lockSeller(tx, ctx.sellerId);
      const now = input.now ?? (await dbNow(tx));
      const seller = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { trialEndsAt: true, launchDiscountUsedAt: true, subscription: true } });
      const before = seller.subscription;
      const plan = before
        ? await tx.subscriptionPlan.findUnique({ where: { id: before.planId } })
        : await sellerPlanOf(tx, ctx.sellerId);
      if (!plan) return { kind: "error", reason: "plan_missing" };

      const inTrial = !!seller.trialEndsAt && seller.trialEndsAt > now;
      // 처음이거나 해지된 뒤 다시 구독하면 새 구독자다(구독 시작 시각을 새로, 기간도 지금부터).
      const restart = isEndedSubscription(before, now);
      const paidActive = before?.status === "ACTIVE" && !!before.currentPeriodEnd && before.currentPeriodEnd > now;
      const cardOnly = paidActive || (inTrial && before?.status !== "PAST_DUE");
      const nextChargeAt = paidActive ? after(before!.currentPeriodEnd!, -RENEW_LEAD_MS) : cardOnly ? seller.trialEndsAt : before?.nextChargeAt ?? null;
      // 카드를 다시 등록하면 자동결제를 다시 켠다(해지 예약을 푼다).
      const card = { billingKeyCipher, cardLabel: issued.cardLabel, cancelAtPeriodEnd: false };
      const sub = await tx.sellerSubscription.upsert({
        where: { sellerId: ctx.sellerId },
        // 런칭 할인을 이미 쓴 계정의 새 구독은 정가다(대표님 결정 2026-10-04)
        create: { sellerId: ctx.sellerId, planId: plan.id, ...card, nextChargeAt, createdAt: now, subscribedAt: now, regularPrice: !!seller.launchDiscountUsedAt },
        update: {
          ...card,
          // 카드만 등록하는 경우(결제한 기간이 남음·체험하기 중)는 결제 없이도 정상 구독이다
          ...(cardOnly ? { status: "ACTIVE" as const, nextChargeAt, canceledAt: null } : {}),
          // 다시 구독하면 새 가입자다: 이전 전 가격 스냅숏도 비운다(그때 플랜 가격, ONQ 1-C)
          // 런칭 할인을 이미 쓴 계정이면 이 구독은 정가다(대표님 결정 2026-10-04, 이전 전 STANDARD 결제는 사용으로 세지 않음)
          // 해지 전에 예약한 하위 변경도 끝난 구독의 것이라 비운다(#186 Codex P2)
          ...(restart
            ? { subscribedAt: now, legacyPrice: null, legacyPriceNoticeSentAt: null, regularPrice: !!seller.launchDiscountUsedAt, pendingPlanId: null }
            : {}),
        },
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
      // 기간은 카드 등록 전 상태로 정한다(해지 예약이 끝난 구독은 새로 시작)
      const period = planPeriod(before, now);
      if (sub.billingAnchorAt?.getTime() !== period.anchor.getTime()) {
        await tx.sellerSubscription.update({ where: { id: sub.id }, data: { billingAnchorAt: period.anchor } });
      }
      // 해지 시각과 비교하므로 같은 시계(now)로 남긴다
      const { payment, plan: charged } = await createPeriodPayment(tx, sub.id, { period, now, scheduled: false });
      return { kind: "charge", payment, orderName: charged.name };
    })
    .catch((e): Prepared => {
      // 예약 결제가 같은 순간 청구를 만들었으면(구독당 PENDING 1건) 진행 중으로 본다
      if (isUniqueViolation(e)) return { kind: "error", reason: "payment_in_progress" };
      throw e;
    });

  if (prepared.kind === "error") return { ok: false, reason: prepared.reason };
  if (prepared.kind === "card_only") return { ok: true, charged: false, currentPeriodEnd: prepared.end, nextChargeAt: prepared.nextChargeAt };

  let result: ChargeResult;
  try {
    result = await provider.charge({
      billingKey: issued.billingKey,
      customerKey: ctx.sellerId,
      amount: prepared.payment.amount,
      orderId: prepared.payment.id,
      orderName: prepared.orderName,
    });
  } catch {
    // 결제됐는지 알 수 없다. PENDING으로 두고 정리 함수가 같은 청구 id로 PG에 확인한다.
    return { ok: false, reason: "payment_pending" };
  }
  await settlePayment(db, prepared.payment.id, result, { actorType: ctx.actorType, actorId: ctx.actorId, now: input.now });
  if (!result.ok) return { ok: false, reason: "payment_failed" };
  // 응답은 PG 결과가 아니라 반영된 뒤의 실제 구독 상태로 정한다(그사이 해지 등으로 이 결제가 기간에 반영되지 않았으면 성공이 아님).
  const state = await db.sellerSubscription.findUniqueOrThrow({
    where: { sellerId: ctx.sellerId },
    select: { status: true, currentPeriodStart: true, currentPeriodEnd: true, nextChargeAt: true },
  });
  const applied =
    state.status === "ACTIVE" &&
    state.currentPeriodStart?.getTime() === prepared.payment.periodStart.getTime() &&
    state.currentPeriodEnd?.getTime() === prepared.payment.periodEnd.getTime();
  return applied
    ? { ok: true, charged: true, currentPeriodEnd: state.currentPeriodEnd, nextChargeAt: state.nextChargeAt }
    : { ok: false, reason: "not_activated" };
}

// 결제 결과를 청구·구독에 반영한다. 이미 확정된 청구면 아무것도 하지 않는다(여러 번 불러도 안전).
// 성공: 이용 기간을 그 청구 기간으로, 다음 결제를 기간 끝 하루 전으로, 재시도·유예를 지운다.
// 예약 결제 실패: 처음 실패면 PAST_DUE + 유예(지금 + 7일), 이후 실패마다 재시도 횟수를 올리고 3번을 넘기면 더 시도하지 않는다.
// 판매자가 직접 한 결제(카드 등록)가 실패하면 구독 상태는 그대로 둔다.
export async function settlePayment(
  db: PrismaClient,
  paymentId: string,
  result: ChargeResult,
  opts: { actorType: ActorType; actorId: string | null; now?: Date },
): Promise<{ nextChargeAt: Date | null } | null> {
  return db.$transaction(async (tx) => {
    const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
    await lockSeller(tx, payment.sellerId);
    const now = opts.now ?? (await dbNow(tx));
    const claimed = await tx.subscriptionPayment.updateMany({
      where: { id: paymentId, status: "PENDING" },
      data: result.ok
        ? { status: "PAID", paidAt: now, providerPaymentId: result.paymentId, receiptUrl: result.receiptUrl }
        : { status: "FAILED", failureReason: result.reason.slice(0, 200) },
    });
    if (claimed.count !== 1) return null;

    let nextChargeAt: Date | null = null;
    const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id: payment.subscriptionId } });
    // 해지 전에 만든 청구가 해지 뒤에 확정되면 구독을 되살리지 않는다(PG에서 결제가 확인된 건은 환불 대상으로만 남긴다).
    // 해지 뒤에 만든 청구(다시 구독)는 정상 결제로 처리해 아래에서 ACTIVE·잠금 해제·자동 해지 복구까지 한다.
    const createdBeforeCancel = !sub.canceledAt || payment.createdAt <= sub.canceledAt;
    if (sub.status === "CANCELED" && (createdBeforeCancel || !result.ok)) {
      await writeAudit(tx, {
        actorType: opts.actorType,
        actorId: opts.actorId,
        sellerId: payment.sellerId,
        action: result.ok ? "subscription.refund_required" : "subscription.payment_failed",
        targetType: "SubscriptionPayment",
        targetId: payment.id,
        after: { amount: payment.amount, scheduled: payment.scheduled, canceledSubscription: true },
        reason: result.ok ? "paid_after_cancel" : result.reason.slice(0, 200),
      });
      return { nextChargeAt: null };
    }
    // 런칭가 청구가 처음 확정되면(해지 뒤 확정돼 환불 대상인 청구는 빼고) 계정에 런칭 할인 사용을 남긴다(대표님 결정 2026-10-04)
    if (result.ok && payment.launchDiscount) {
      await tx.seller.updateMany({ where: { id: payment.sellerId, launchDiscountUsedAt: null }, data: { launchDiscountUsedAt: now } });
    }
    // 결제 중 상위 변경의 차액(ONQ 1-C-2): 확정되면 플랜만 바꾸고 기간·결제일은 그대로, 실패·거절이면 지금 플랜 그대로(유예 없음)
    if (payment.kind === "PRORATION") {
      if (result.ok && payment.targetPlanId) await switchPlan(tx, sub.id, payment.sellerId, payment.targetPlanId);
      await writeAudit(tx, {
        actorType: opts.actorType,
        actorId: opts.actorId,
        sellerId: payment.sellerId,
        action: result.ok ? "subscription.plan_upgraded" : "subscription.plan_upgrade_failed",
        targetType: "SubscriptionPayment",
        targetId: payment.id,
        after: { amount: payment.amount, targetPlanId: payment.targetPlanId },
        reason: result.ok ? undefined : result.reason.slice(0, 200),
      });
      return { nextChargeAt: sub.nextChargeAt };
    }
    if (result.ok) {
      // 체험 중·유예 중 상위 변경의 기간 결제: 확정되면 플랜을 바꾸고 체험을 끝낸다(ONQ 1-C-2)
      if (payment.targetPlanId) {
        await switchPlan(tx, sub.id, payment.sellerId, payment.targetPlanId);
        await tx.seller.updateMany({ where: { id: payment.sellerId, trialEndsAt: { gt: now } }, data: { trialEndsAt: now } });
      }
      nextChargeAt = after(payment.periodEnd, -RENEW_LEAD_MS);
      await tx.sellerSubscription.update({
        where: { id: sub.id },
        data: {
          status: "ACTIVE",
          currentPeriodStart: payment.periodStart,
          currentPeriodEnd: payment.periodEnd,
          nextChargeAt: sub.cancelAtPeriodEnd ? payment.periodEnd : nextChargeAt,
          retryCount: 0,
          graceUntil: null,
          canceledAt: null,
        },
      });
      await restoreAfterResubscribe(tx, payment.sellerId, opts.actorType, opts.actorId);
    } else if (payment.scheduled && sub.cancelAtPeriodEnd) {
      // 해지 예약된 구독은 다시 시도하지 않고 기간 끝에 해지한다
      nextChargeAt = sub.currentPeriodEnd;
      await tx.sellerSubscription.update({ where: { id: sub.id }, data: { nextChargeAt } });
    } else if (payment.scheduled) {
      if (sub.status !== "PAST_DUE") {
        nextChargeAt = after(now, RETRY_INTERVAL_MS);
        await tx.sellerSubscription.update({ where: { id: sub.id }, data: { status: "PAST_DUE", retryCount: 0, graceUntil: after(now, GRACE_MS), nextChargeAt } });
      } else {
        const retryCount = Math.min(sub.retryCount + 1, MAX_RETRIES);
        nextChargeAt = retryCount >= MAX_RETRIES ? null : after(now, RETRY_INTERVAL_MS);
        await tx.sellerSubscription.update({ where: { id: sub.id }, data: { retryCount, nextChargeAt } });
      }
    } else {
      nextChargeAt = sub.nextChargeAt;
    }
    await writeAudit(tx, {
      actorType: opts.actorType,
      actorId: opts.actorId,
      sellerId: payment.sellerId,
      action: result.ok ? "subscription.payment_paid" : "subscription.payment_failed",
      targetType: "SubscriptionPayment",
      targetId: payment.id,
      after: { amount: payment.amount, scheduled: payment.scheduled },
      reason: result.ok ? undefined : result.reason.slice(0, 200),
    });
    return { nextChargeAt };
  });
}

// ───────────── 해지 ─────────────

// 결제한 기간이 남아 있으면 그 기간 끝까지 쓰고 다음 결제를 하지 않는다(즉시 환불 없음).
// 결제한 기간이 없으면(체험하기 중 카드만 등록, 자동결제 실패 유예 중) 바로 해지하고 청구하지 않는다.
// 어느 쪽이든 재시도·유예는 지운다.
export async function cancelSubscription(db: PrismaClient, ctx: TenantContext, input: { now?: Date } = {}) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const now = input.now ?? (await dbNow(tx));
    const sub = await tx.sellerSubscription.findUnique({ where: { sellerId: ctx.sellerId } });
    if (!sub || sub.status === "CANCELED" || sub.cancelAtPeriodEnd) return { ok: false as const, reason: "not_subscribed" as const };
    // 결제를 처리하는 중(PENDING 청구)에는 해지하지 않는다(결제 결과와 해지가 엇갈리지 않게)
    if (await tx.subscriptionPayment.findFirst({ where: { subscriptionId: sub.id, status: "PENDING" }, select: { id: true } })) {
      return { ok: false as const, reason: "payment_in_progress" as const };
    }
    const paidThrough = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : null;
    await tx.sellerSubscription.update({
      where: { id: sub.id },
      data: paidThrough
        ? { cancelAtPeriodEnd: true, nextChargeAt: paidThrough, graceUntil: null, retryCount: 0 }
        : { cancelAtPeriodEnd: true, status: "CANCELED", canceledAt: now, nextChargeAt: null, graceUntil: null, retryCount: 0, pendingPlanId: null },
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

export type RenewSummary = { charged: number; failed: number; canceled: number; skipped: number; pending: number; errors: number };

// nextChargeAt이 지난 구독을 처리한다. 예약 실행(인프라 승인 후 연결)에서 주기적으로 부른다.
// 구독마다 따로 처리해 한 곳이 실패해도 나머지는 계속한다. 진행 중 청구가 있으면 건너뛴다.
export async function renewDueSubscriptions(db: PrismaClient, provider: BillingProvider, input: { now?: Date } = {}): Promise<RenewSummary> {
  const now = input.now ?? (await dbNow(db));
  const summary: RenewSummary = { charged: 0, failed: 0, canceled: 0, skipped: 0, pending: 0, errors: 0 };
  const due = await db.sellerSubscription.findMany({
    where: { status: { in: ["ACTIVE", "PAST_DUE"] }, nextChargeAt: { lte: now } },
    select: { id: true, sellerId: true },
  });

  for (const { id, sellerId } of due) {
    try {
      const prepared = await db
        .$transaction(async (tx) => {
          await lockSeller(tx, sellerId);
          // 잠근 뒤 다시 읽는다(그사이 결제·해지·카드 교체가 있었을 수 있음).
          const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id }, include: { plan: true } });
          if (sub.status === "CANCELED" || !sub.nextChargeAt || sub.nextChargeAt > now) return null;
          if (sub.cancelAtPeriodEnd) {
            if (sub.currentPeriodEnd && sub.currentPeriodEnd > now) return null;
            await tx.sellerSubscription.update({ where: { id }, data: { status: "CANCELED", canceledAt: now, nextChargeAt: null, pendingPlanId: null } });
            await writeAudit(tx, { actorType: "SYSTEM", sellerId, action: "subscription.canceled", targetType: "SellerSubscription", targetId: id });
            return "canceled" as const;
          }
          if (!sub.billingKeyCipher) return null;
          if (await tx.subscriptionPayment.findFirst({ where: { subscriptionId: id, status: "PENDING" }, select: { id: true } })) return null;
          const period = planPeriod(sub, now);
          if (sub.billingAnchorAt?.getTime() !== period.anchor.getTime()) {
            await tx.sellerSubscription.update({ where: { id }, data: { billingAnchorAt: period.anchor } });
          }
          const { payment, plan: charged } = await createPeriodPayment(tx, id, { period, now, scheduled: true });
          return { payment, billingKey: openBillingKey(sub.billingKeyCipher, sellerId), orderName: charged.name };
        })
        .catch((e) => {
          if (isUniqueViolation(e)) return null; // 같은 기간 청구나 진행 중 청구가 이미 있음
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
      let result: ChargeResult;
      try {
        result = await provider.charge({
          billingKey: prepared.billingKey,
          customerKey: sellerId,
          amount: prepared.payment.amount,
          orderId: prepared.payment.id,
          orderName: prepared.orderName,
        });
      } catch {
        summary.pending++; // PENDING으로 두고 정리 함수가 확정한다
        continue;
      }
      await settlePayment(db, prepared.payment.id, result, { actorType: "SYSTEM", actorId: null, now: input.now });
      if (result.ok) summary.charged++;
      else summary.failed++;
    } catch (e) {
      summary.errors++;
      console.error("renewDueSubscriptions", id, e);
    }
  }
  return summary;
}

// ───────────── PG 결과를 못 받은 청구 정리 (예약 실행) ─────────────

export type ReconcileSummary = { paid: number; failed: number; recharged: number; unresolved: number };

// 오래된 PENDING 청구를 같은 청구 id로 PG에 조회해 확정한다.
// PG에 결제 기록이 있으면 그 결과로, 없으면(결제 요청이 PG에 닿지 않음) 같은 id로 다시 요청한다.
export async function reconcileStalePayments(
  db: PrismaClient,
  provider: BillingProvider,
  input: { now?: Date; staleMs?: number } = {},
): Promise<ReconcileSummary> {
  const now = input.now ?? (await dbNow(db));
  const summary: ReconcileSummary = { paid: 0, failed: 0, recharged: 0, unresolved: 0 };
  const stale = await db.subscriptionPayment.findMany({
    where: { status: "PENDING", createdAt: { lte: after(now, -(input.staleMs ?? STALE_PENDING_MS)) } },
    include: { subscription: { select: { billingKeyCipher: true } } },
  });
  for (const p of stale) {
    try {
      const found = await provider.getPayment(p.id);
      let result: ChargeResult;
      if (found.status === "PAID") result = { ok: true, paymentId: found.paymentId, receiptUrl: found.receiptUrl };
      else if (found.status === "FAILED") result = { ok: false, reason: found.reason };
      else {
        // PG에 기록이 없으면 다시 요청하기 전에, 판매자를 잠그고 구독을 다시 읽어 해지됐는지 본다.
        // 해지(CANCELED)했거나 해지 예약을 했으면 다시 결제하지 않고 청구를 닫는다.
        const closed = await db.$transaction(async (tx) => {
          await lockSeller(tx, p.sellerId);
          const sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id: p.subscriptionId } });
          if (sub.status !== "CANCELED" && !sub.cancelAtPeriodEnd) return false;
          const moved = await tx.subscriptionPayment.updateMany({ where: { id: p.id, status: "PENDING" }, data: { status: "FAILED", failureReason: "canceled" } });
          if (moved.count === 1) {
            await writeAudit(tx, {
              actorType: "SYSTEM",
              sellerId: p.sellerId,
              action: "subscription.payment_closed",
              targetType: "SubscriptionPayment",
              targetId: p.id,
              reason: "canceled",
            });
          }
          if (sub.cancelAtPeriodEnd && sub.status !== "CANCELED") {
            await tx.sellerSubscription.update({ where: { id: sub.id }, data: { nextChargeAt: sub.currentPeriodEnd } });
          }
          return true;
        });
        if (closed) {
          summary.failed++;
          continue;
        }
        if (!p.subscription.billingKeyCipher) {
          result = { ok: false, reason: "no_card" };
        } else {
          const plan = await db.sellerSubscription.findUniqueOrThrow({ where: { id: p.subscriptionId }, select: { plan: { select: { name: true } } } });
          result = await provider.charge({
            billingKey: openBillingKey(p.subscription.billingKeyCipher, p.sellerId),
            customerKey: p.sellerId,
            amount: p.amount,
            orderId: p.id,
            orderName: plan.plan.name,
          });
          summary.recharged++;
        }
      }
      await settlePayment(db, p.id, result, { actorType: "SYSTEM", actorId: null, now: input.now });
      if (result.ok) summary.paid++;
      else summary.failed++;
    } catch (e) {
      summary.unresolved++;
      console.error("reconcileStalePayments", p.id, e);
    }
  }
  return summary;
}

// ───────────── 잠금 30일 뒤 자동 해지 (예약 실행) ─────────────

// 잠긴 지 30일이 지난 쇼핑몰을 해지 상태로 바꾼다: serviceEndedAt 기록(90일 보관 시작), 구독 CANCELED,
// 연결 도메인 비활성. 데이터 삭제는 하지 않는다(별도 작업). 다시 구독하면 restoreAfterResubscribe가 되살린다.
export async function closeLongLockedSellers(db: PrismaClient, input: { now?: Date } = {}): Promise<{ closed: number }> {
  const now = input.now ?? (await dbNow(db));
  const cutoff = after(now, -AUTO_CLOSE_AFTER_MS);
  // 잠긴 지 30일이 지났다면 체험하기도 그 전에 끝났다
  const candidates = await db.seller.findMany({
    where: { status: "ACTIVE", serviceEndedAt: null, trialEndsAt: { lte: cutoff } },
    select: { id: true },
  });
  let closed = 0;
  for (const { id } of candidates) {
    const done = await db.$transaction(async (tx) => {
      await lockSeller(tx, id);
      const seller = await tx.seller.findUniqueOrThrow({
        where: { id },
        select: { status: true, serviceEndedAt: true, trialEndsAt: true, subscription: { select: { id: true, ...ACCESS_SELECT } } },
      });
      if (seller.status !== "ACTIVE" || seller.serviceEndedAt) return false;
      const input = { trialEndsAt: seller.trialEndsAt, subscription: seller.subscription };
      if (sellerAccess(input, now) !== "expired") return false;
      const since = lockedSince(input);
      if (!since || since > cutoff) return false;
      await tx.seller.update({ where: { id }, data: { serviceEndedAt: now } });
      if (seller.subscription) {
        await tx.sellerSubscription.update({ where: { id: seller.subscription.id }, data: { status: "CANCELED", canceledAt: now, nextChargeAt: null, pendingPlanId: null } });
      }
      const domains = await tx.sellerDomain.updateMany({ where: { sellerId: id, suspendedAt: null }, data: { suspendedAt: now } });
      await writeAudit(tx, {
        actorType: "SYSTEM",
        sellerId: id,
        action: "subscription.auto_closed",
        targetType: "Seller",
        targetId: id,
        after: { lockedSince: since, suspendedDomains: domains.count },
      });
      return true;
    });
    if (done) closed++;
  }
  return { closed };
}

// 자동 해지된 쇼핑몰이 보관 기간 안에 다시 결제하면 해지 표시를 지우고, 해지 때 푼 도메인을 되살린다.
async function restoreAfterResubscribe(tx: Tx, sellerId: string, actorType: ActorType, actorId: string | null) {
  const seller = await tx.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { serviceEndedAt: true } });
  if (!seller.serviceEndedAt) return;
  const domains = await tx.sellerDomain.updateMany({ where: { sellerId, suspendedAt: seller.serviceEndedAt }, data: { suspendedAt: null } });
  await tx.seller.update({ where: { id: sellerId }, data: { serviceEndedAt: null } });
  await writeAudit(tx, {
    actorType,
    actorId,
    sellerId,
    action: "subscription.restored",
    targetType: "Seller",
    targetId: sellerId,
    after: { restoredDomains: domains.count },
  });
}

// 구독·판매자 플랜을 바꾼다(상위 변경 확정, 예약된 하위 변경 적용, 결제 없는 즉시 변경). 예약된 하위 변경과
// 이전 전 가격 스냅숏(STANDARD → 통합 이전의 고지 규칙)은 플랜이 바뀌면 끝나므로 비운다.
export async function switchPlan(tx: Tx, subscriptionId: string | null, sellerId: string, planId: string) {
  if (subscriptionId) {
    await tx.sellerSubscription.update({
      where: { id: subscriptionId },
      data: { planId, pendingPlanId: null, legacyPrice: null, legacyPriceNoticeSentAt: null },
    });
  }
  await tx.seller.update({ where: { id: sellerId }, data: { planId } });
}

// 이용 기간을 시작하는 청구(정기 갱신·재시도, 카드 등록·교체 때의 즉시 결제·재구독)는 모두 이 함수로 만든다(#186 Codex).
// 이번 기간에 청구할 플랜을 한곳에서 정한다: 예약된 하위 변경이 있으면(해지 예약이 아니면) 먼저 옮기고, 금액은 chargeFor.
// 상위 변경 청구(planChange.ts)는 대상 플랜이 정해진 따로의 청구이고, 대사(reconcileStalePayments)는 이미 만든 청구를 다시 확인할 뿐이다.
export async function createPeriodPayment(
  tx: Tx,
  subscriptionId: string,
  input: { period: { start: Date; end: Date }; now: Date; scheduled: boolean },
): Promise<{ payment: SubscriptionPayment; plan: SubscriptionPlan }> {
  let sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { plan: true } });
  if (sub.pendingPlanId && !sub.cancelAtPeriodEnd) {
    await switchPlan(tx, sub.id, sub.sellerId, sub.pendingPlanId);
    sub = await tx.sellerSubscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { plan: true } });
  }
  const payment = await tx.subscriptionPayment.create({
    data: {
      sellerId: sub.sellerId,
      subscriptionId: sub.id,
      ...(await chargeFor(tx, sub.plan, sub, input.now)),
      periodStart: input.period.start,
      periodEnd: input.period.end,
      scheduled: input.scheduled,
      createdAt: input.now,
    },
  });
  return { payment, plan: sub.plan };
}
