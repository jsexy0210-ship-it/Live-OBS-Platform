import { lockedSince, sellerAccess, type AccessInput } from "./access";
import { POLICY_DEFS, type PolicyKey } from "../admin/platformPolicy";

const DAY = 86_400_000;
const POLICY_KEYS = ["paymentRetryCount", "overdueLockDays", "lockToCloseDays", "dataRetentionDays", "priceNoticeDays"] as const satisfies readonly PolicyKey[];
type Policies = Record<(typeof POLICY_KEYS)[number], number>;
type Subscription = NonNullable<AccessInput["subscription"]> & {
  id: string; sellerId: string; planId: string; subscribedAt: Date; retryCount: number;
  hasBillingKey: boolean; hasPendingPayment: boolean;
  legacyPrice: number | null; legacyPriceNoticeSentAt: Date | null; regularPrice: boolean;
};
export type LifecycleSnapshot = AccessInput & {
  sellerId: string; status: string; serviceEndedAt: Date | null;
  subscription: Subscription | null;
};
export type PriceChangeSnapshot = {
  id: string; planId: string; changedAt: Date; changedByAdmin: boolean;
};
// 수신 주소/금액/비밀값을 받지 않는다. 정상 요금 변경의 영속 통지 근거는 아직 없다.
// DB/provider/callback 인자·실행 route·scheduler 등록을 두지 않는다.
const UNKNOWN_NOTICE = ["ADVANCE_NOTICE_DAYS_UNDEFINED", "CHANNEL_FAILURE_POLICY_UNDEFINED", "NOTICE_DELIVERY_NOT_RECORDED"] as const;
const RETAIN = ["ORDER_PAYMENT_RECORDS", "FINANCIAL_LEDGERS", "TRADE_AUDIT_RECORDS"] as const;
const iso = (d: Date | null) => d?.toISOString() ?? null;
const afterDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
const validDate = (d: Date) => Number.isFinite(d.getTime());

/** PRODUCT_SCOPE 결제실패/해지 정책의 관측용 계산. 모든 시각은 호출자가 확보한 같은 DB at 기준.
 * 실패 최초일은 기존 graceUntil에서 현재 정책을 역산하지 않는다(정책이 이후 바뀌었을 수 있다).
 * 현재 상태 스냅숏일 뿐 잠금/복원/삭제/청구의 실행 자격이나 역사적 상태를 보장하지 않는다.
 */
export function planSubscriptionLifecycle(input: {
  at: Date; policies: Policies; sellers: readonly LifecycleSnapshot[]; priceChanges: readonly PriceChangeSnapshot[];
}) {
  const { at, policies } = input;
  if (!validDate(at)) throw new Error("INVALID_SNAPSHOT_TIME");
  for (const [key, value] of Object.entries(policies)) {
    const def = POLICY_DEFS.find((d) => d.key === key);
    if (!def || !Number.isInteger(value) || (def.min != null && value < def.min) || (def.max != null && value > def.max) || (def.options && !def.options.includes(value))) throw new Error("INVALID_POLICY");
  }
  for (const key of POLICY_KEYS) {
    if (!Number.isInteger(policies[key])) throw new Error("MISSING_POLICY");
  }
  const sellerIds = new Set<string>(), subscriptionIds = new Set<string>(), changeIds = new Set<string>();
  for (const c of input.priceChanges) {
    if (!c.id || !c.planId || changeIds.has(c.id)) throw new Error("DUPLICATE_OR_INVALID_PRICE_CHANGE");
    changeIds.add(c.id);
    if (!validDate(c.changedAt) || c.changedAt > at) throw new Error("INVALID_PRICE_CHANGE_TIME");
  }
  const sellers = input.sellers.map((s) => {
    if (!s.sellerId || sellerIds.has(s.sellerId)) throw new Error("DUPLICATE_OR_INVALID_SELLER");
    sellerIds.add(s.sellerId);
    const sub = s.subscription;
    if (sub) {
      if (sub.sellerId !== s.sellerId) throw new Error("SUBSCRIPTION_TENANT_MISMATCH");
      if (!sub.id || !sub.planId || subscriptionIds.has(sub.id)) throw new Error("DUPLICATE_OR_INVALID_SUBSCRIPTION");
      subscriptionIds.add(sub.id);
      if (!Number.isInteger(sub.retryCount) || sub.retryCount < 0) throw new Error("INVALID_RETRY_COUNT");
    }
    for (const d of [s.trialEndsAt, s.serviceEndedAt, sub?.currentPeriodEnd, sub?.graceUntil, sub?.nextChargeAt, sub?.subscribedAt, sub?.legacyPriceNoticeSentAt]) {
      if (d && !validDate(d)) throw new Error("INVALID_SNAPSHOT_DATE");
    }
    if ((s.serviceEndedAt && s.serviceEndedAt > at) || (sub && sub.subscribedAt > at) || (sub?.legacyPriceNoticeSentAt && sub.legacyPriceNoticeSentAt > at)) throw new Error("FUTURE_EVENT");
    const access = sellerAccess(s, at), since = lockedSince(s);
    // subscription.closeLongLockedSellers의 ACTIVE/체험끝/expired/since 조건을 그대로 관측한다.
    const closeAt = since ? afterDays(since, policies.lockToCloseDays) : null;
    const closeCandidate = s.status === "ACTIVE" && !s.serviceEndedAt && !!s.trialEndsAt && s.trialEndsAt <= afterDays(at, -policies.lockToCloseDays) && access === "expired" && !!closeAt && closeAt <= at;
    const due = !!sub && ["ACTIVE", "PAST_DUE"].includes(sub.status) && !!sub.nextChargeAt && sub.nextChargeAt <= at && s.status !== "SUSPENDED";
    const retryBlocks = [
      ...(s.serviceEndedAt ? ["SERVICE_ENDED"] : []),
      ...(sub?.hasPendingPayment ? ["PENDING_PAYMENT"] : []),
      ...(sub && !sub.hasBillingKey ? ["BILLING_KEY_MISSING"] : []),
      ...(sub?.cancelAtPeriodEnd ? ["CANCEL_SCHEDULED"] : []),
      ...(sub && sub.retryCount >= policies.paymentRetryCount ? ["RETRY_LIMIT_REACHED"] : []),
    ];
    const scopeConflict = policies.dataRetentionDays !== 90;
    const retentionAt = s.serviceEndedAt ? afterDays(s.serviceEndedAt, 90) : null;
    const configuredRetentionAt = s.serviceEndedAt ? afterDays(s.serviceEndedAt, policies.dataRetentionDays) : null;
    const changes = input.priceChanges.filter((c) => sub && c.planId === sub.planId && c.changedAt > sub.subscribedAt);
    const notices = changes.filter((c) => c.changedByAdmin && sub && ["ACTIVE", "PAST_DUE"].includes(sub.status) && !sub.cancelAtPeriodEnd).map((c) => ({
      eventKey: `${s.sellerId}:price:${c.id}`, changeId: c.id,
      currentTimeRuleReached: afterDays(c.changedAt, 30) <= at,
      currentAppliesFrom: afterDays(c.changedAt, 30).toISOString(),
      deliveryEvidence: "NOT_RECORDED" as const, safeApply: false as const,
      blockedReasons: ["NOTICE_DELIVERY_NOT_RECORDED", "CHANNEL_FAILURE_POLICY_UNDEFINED", "PRICE_NOTICE_DAYS_NOT_APPLIED"],
    }));
    return {
      sellerId: s.sellerId, subscriptionId: sub?.id ?? null, access,
      failure: { retryCount: sub?.retryCount ?? 0, retryLimit: policies.paymentRetryCount, retryIntervalDays: 1, graceUntil: iso(sub?.graceUntil ?? null), initialFailureAt: null, initialFailureReason: "NOT_RECORDED", currentGracePolicyDays: policies.overdueLockDays },
      retry: { due, candidate: due && sub?.status === "PAST_DUE" && retryBlocks.length === 0, nextChargeAt: iso(sub?.nextChargeAt ?? null), blockedReasons: retryBlocks },
      lock: { locked: !s.serviceEndedAt && access === "expired", since: iso(since), autoCloseAt: iso(closeAt) },
      close: { candidate: closeCandidate, eventKey: closeCandidate ? `${s.sellerId}:close:${since!.toISOString()}` : null, blockedReasons: [...UNKNOWN_NOTICE, ...(sub?.hasPendingPayment ? ["PENDING_PAYMENT"] : [])] },
      retention: {
        sourceDays: 90, configuredDays: policies.dataRetentionDays, sourceEndsAt: iso(retentionAt), configuredEndsAt: iso(configuredRetentionAt),
        candidate: scopeConflict ? null : !!retentionAt && retentionAt <= at,
        blockedReasons: [...(scopeConflict ? ["RETENTION_POLICY_CONFLICT"] : []), "RETENTION_POLICY_NOT_APPLIED", "TENANT_RETENTION_MAP_UNRESOLVED", "LEDGER_FK_RETENTION_UNRESOLVED", ...UNKNOWN_NOTICE, ...(sub?.hasPendingPayment ? ["PENDING_PAYMENT"] : [])],
        protectedGroups: RETAIN, orderPaymentRetentionYears: 5, legalAssessment: "NOT_PERFORMED",
      },
      restore: { sameSellerWithinSourceWindow: scopeConflict ? null : !!retentionAt && at < retentionAt, blockedReasons: ["RESTORE_SCOPE_UNDEFINED", "PURGE_COMPLETION_NOT_RECORDED", ...(scopeConflict ? ["RETENTION_POLICY_CONFLICT"] : [])] },
      priceNotices: notices,
      legacyNotice: sub && sub.legacyPrice != null ? { candidate: !sub.legacyPriceNoticeSentAt && ["ACTIVE", "PAST_DUE"].includes(sub.status), deliveryEvidence: sub.legacyPriceNoticeSentAt ? "LEGACY_SENT_AT_ONLY" : "NOT_RECORDED", currentLegacyPriceHeld: !sub.regularPrice && (!sub.legacyPriceNoticeSentAt || afterDays(sub.legacyPriceNoticeSentAt, 30) > at), safeApply: false, blockedReasons: ["CHANNEL_FAILURE_POLICY_UNDEFINED", "PRICE_NOTICE_DAYS_NOT_APPLIED"] } : null,
    };
  });
  return {
    mode: "DRY_RUN" as const, executable: false as const, mutations: 0 as const, at: at.toISOString(), timezone: "Asia/Seoul",
    snapshot: "TIME_BOUNDARY_ONLY_CURRENT_STATE" as const, policies: { ...policies }, sellers,
    executionRequirements: ["SELLER_LOCK_AND_STATE_RECHECK", "TENANT_SCOPED_RETENTION_MAP", "NOTICE_DELIVERY_CONTRACT", "EXPLICIT_ACTIVATION_AUTHORITY"],
    sources: ["docs/PRODUCT_SCOPE.md", "lib/server/billing/access.ts", "lib/server/billing/subscription.ts", "lib/server/billing/plans.ts", "lib/server/admin/platformPolicy.ts", "lib/server/buyers/legalHold.ts"],
  };
}
