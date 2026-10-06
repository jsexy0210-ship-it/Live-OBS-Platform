import { describe, expect, it } from "vitest";
import { planSubscriptionLifecycle, type LifecycleSnapshot } from "../../lib/server/billing/lifecycleDryRun";

const AT = new Date("2026-10-07T00:00:00.000Z"), DAY = 86_400_000;
const ago = (days: number) => new Date(AT.getTime() - days * DAY);
const policies = { paymentRetryCount: 3, overdueLockDays: 7, lockToCloseDays: 30, dataRetentionDays: 90, priceNoticeDays: 30 };
const seller = (): LifecycleSnapshot => ({
  sellerId: "tenant-a", status: "ACTIVE", serviceEndedAt: null, trialEndsAt: ago(60),
  subscription: { id: "sub-a", sellerId: "tenant-a", planId: "plan-a", subscribedAt: ago(100), status: "PAST_DUE", currentPeriodEnd: ago(40), nextChargeAt: ago(1), graceUntil: ago(30), cancelAtPeriodEnd: false, retryCount: 2, hasBillingKey: true, hasPendingPayment: false, legacyPrice: null, legacyPriceNoticeSentAt: null, regularPrice: false },
});
const plan = (s = seller(), p = policies, at = AT) => planSubscriptionLifecycle({ at, policies: p, sellers: [s], priceChanges: [] });

describe("구독 수명주기 계산 전용 dry-run", () => {
  it("같은 시각의 스냅숏을 변경하지 않고 실행 불가/미정 근거를 반환한다", () => {
    const s = seller(), before = JSON.stringify(s);
    const result = plan(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(result).toMatchObject({ mode: "DRY_RUN", mutations: 0, executable: false, at: AT.toISOString(), timezone: "Asia/Seoul" });
    expect(result.sellers[0].close).toMatchObject({ candidate: true, blockedReasons: expect.arrayContaining(["ADVANCE_NOTICE_DAYS_UNDEFINED", "NOTICE_DELIVERY_NOT_RECORDED"]) });
  });
  it("저장된 grace 7일 경계와 현재 변경 정책을 분리한다", () => {
    const s = seller(); s.subscription!.graceUntil = AT;
    expect(plan(s, { ...policies, overdueLockDays: 14 }, new Date(+AT - 1)).sellers[0].access).toBe("grace");
    const row = plan(s, { ...policies, overdueLockDays: 14 }).sellers[0];
    expect(row.access).toBe("expired");
    expect(row.failure).toMatchObject({ currentGracePolicyDays: 14, graceUntil: AT.toISOString(), initialFailureAt: null });
  });
  it("현재 동적 재시도 한도와 취소/진행 중 결제 차단을 구분한다", () => {
    const s = seller();
    expect(plan(s).sellers[0].retry.candidate).toBe(true);
    expect(plan(s, { ...policies, paymentRetryCount: 2 }).sellers[0].retry.blockedReasons).toContain("RETRY_LIMIT_REACHED");
    s.subscription!.hasPendingPayment = true;
    expect(plan(s).sellers[0].retry.candidate).toBe(false);
    expect(plan(s).sellers[0].close.blockedReasons).toContain("PENDING_PAYMENT");
    s.subscription!.cancelAtPeriodEnd = true;
    expect(plan(s).sellers[0].retry.blockedReasons).toContain("CANCEL_SCHEDULED");
  });
  it("잠금30일 경계와 동적 변경을 기존 close 함수 조건으로 계산한다", () => {
    expect(plan(seller(), policies, new Date(+AT - 1)).sellers[0].close.candidate).toBe(false);
    expect(plan().sellers[0].close.candidate).toBe(true);
    expect(plan(seller(), { ...policies, lockToCloseDays: 31 }).sellers[0].close.candidate).toBe(false);
    const s = seller(); s.trialEndsAt = null;
    expect(plan(s).sellers[0].close.candidate).toBe(false);
  });
  it("scheduler 지연 charging과 정지된 판매자를 실행 후보로 오인하지 않는다", () => {
    const s = seller(); s.subscription!.status = "ACTIVE";
    expect(plan(s).sellers[0]).toMatchObject({ access: "charging", close: { candidate: false } });
    s.status = "SUSPENDED"; s.subscription!.status = "PAST_DUE";
    expect(plan(s).sellers[0].retry.due).toBe(false);
    expect(plan(s).sellers[0].close.candidate).toBe(false);
  });
  it("90일 기한 전/정각을 계산하되 보존원장/FK/복원 범위 차단을 유지한다", () => {
    const s = seller(); s.serviceEndedAt = ago(90);
    const before = plan(s, policies, new Date(+AT - 1)).sellers[0];
    expect(before.restore.sameSellerWithinSourceWindow).toBe(true);
    expect(before.retention.candidate).toBe(false);
    const row = plan(s).sellers[0];
    expect(row.retention).toMatchObject({ candidate: true, orderPaymentRetentionYears: 5, legalAssessment: "NOT_PERFORMED", protectedGroups: expect.arrayContaining(["ORDER_PAYMENT_RECORDS", "FINANCIAL_LEDGERS"]) });
    expect(row.retention.blockedReasons).toContain("TENANT_RETENTION_MAP_UNRESOLVED");
    expect(row.restore).toMatchObject({ sameSellerWithinSourceWindow: false, blockedReasons: expect.arrayContaining(["RESTORE_SCOPE_UNDEFINED"]) });
    expect(row.retry.candidate).toBe(false);
  });
  it("90/180 충돌을 임의로 해결하지 않는다", () => {
    const s = seller(); s.serviceEndedAt = ago(100);
    const row = plan(s, { ...policies, dataRetentionDays: 180 }).sellers[0];
    expect(row.retention.candidate).toBeNull();
    expect(row.restore.sameSellerWithinSourceWindow).toBeNull();
    expect(row.retention.blockedReasons).toContain("RETENTION_POLICY_CONFLICT");
    expect(row.retention.sourceEndsAt).not.toBe(row.retention.configuredEndsAt);
  });
  it("다른 tenant/중복 seller/구독을 거부한다", () => {
    const s = seller(); s.subscription!.sellerId = "tenant-b";
    expect(() => plan(s)).toThrow("SUBSCRIPTION_TENANT_MISMATCH");
    expect(() => planSubscriptionLifecycle({ at: AT, policies, sellers: [seller(), seller()], priceChanges: [] })).toThrow("DUPLICATE_OR_INVALID_SELLER");
    const b = seller(); b.sellerId = "tenant-b"; b.subscription!.sellerId = "tenant-b";
    expect(() => planSubscriptionLifecycle({ at: AT, policies, sellers: [seller(), b], priceChanges: [] })).toThrow("DUPLICATE_OR_INVALID_SUBSCRIPTION");
  });
  it("잘못된/미래 사건 시각과 정책 범위를 거부한다", () => {
    expect(() => plan(seller(), policies, new Date("invalid"))).toThrow("INVALID_SNAPSHOT_TIME");
    expect(() => plan(seller(), { ...policies, priceNoticeDays: 29 })).toThrow("INVALID_POLICY");
    const s = seller(); s.serviceEndedAt = new Date(+AT + 1);
    expect(() => plan(s)).toThrow("FUTURE_EVENT");
  });
  it("각 요금 변경 버전을 유지하고 미통지30일 적용 위험을 차단 판단으로 드러낸다", () => {
    const changes = [
      { id: "old", planId: "plan-a", changedAt: ago(31), changedByAdmin: true },
      { id: "new", planId: "plan-a", changedAt: ago(30), changedByAdmin: true },
      { id: "other", planId: "plan-b", changedAt: ago(40), changedByAdmin: true },
    ];
    const rows = planSubscriptionLifecycle({ at: AT, policies: { ...policies, priceNoticeDays: 60 }, sellers: [seller()], priceChanges: changes }).sellers[0].priceNotices;
    expect(rows.map((r) => r.changeId)).toEqual(["old", "new"]);
    expect(new Set(rows.map((r) => r.eventKey)).size).toBe(2);
    expect(rows.every((r) => r.currentTimeRuleReached && !r.safeApply && r.deliveryEvidence === "NOT_RECORDED")).toBe(true);
    expect(rows[1].currentAppliesFrom).toBe(AT.toISOString());
    expect(rows[1].blockedReasons).toContain("PRICE_NOTICE_DAYS_NOT_APPLIED");
  });
  it("가입 전 요금/취소 예약은 통지 대상에서 빼고 중복 변경을 거부한다", () => {
    const c = { id: "c", planId: "plan-a", changedAt: ago(100), changedByAdmin: true };
    expect(planSubscriptionLifecycle({ at: AT, policies, sellers: [seller()], priceChanges: [c] }).sellers[0].priceNotices).toEqual([]);
    expect(() => planSubscriptionLifecycle({ at: AT, policies, sellers: [], priceChanges: [c, c] })).toThrow("DUPLICATE_OR_INVALID_PRICE_CHANGE");
    const s = seller(); s.subscription!.cancelAtPeriodEnd = true;
    expect(planSubscriptionLifecycle({ at: AT, policies, sellers: [s], priceChanges: [{ ...c, changedAt: ago(31) }] }).sellers[0].priceNotices).toEqual([]);
  });
  it("legacy 발송시각은 현재30일 계산 근거만 제공하며 두 채널 성공을 주장하지 않는다", () => {
    const s = seller(); s.subscription!.legacyPrice = 100;
    expect(plan(s).sellers[0].legacyNotice).toMatchObject({ candidate: true, currentLegacyPriceHeld: true, safeApply: false });
    s.subscription!.legacyPriceNoticeSentAt = ago(30);
    expect(plan(s).sellers[0].legacyNotice).toMatchObject({ candidate: false, currentLegacyPriceHeld: false, deliveryEvidence: "LEGACY_SENT_AT_ONLY", safeApply: false });
    expect(plan(s, policies, new Date(+AT - 1)).sellers[0].legacyNotice?.currentLegacyPriceHeld).toBe(true);
  });
});
