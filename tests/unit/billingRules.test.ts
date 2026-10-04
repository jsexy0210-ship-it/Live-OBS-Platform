import { describe, expect, it } from "vitest";
import { canCancelSubscription, cardRegistrationCharges, isCancelScheduled, isEndedSubscription, planChangeState } from "../../lib/server/billing/access";

// 구독 판정 함수(서버 changePlan·cancelSubscription·registerCardAndPay와 파트너스 구독 화면이 함께 쓴다)
const NOW = new Date("2026-11-01T00:00:00Z");
const DAY = 86_400_000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);
type Sub = { status: string; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; cancelAtPeriodEnd: boolean };
const sub = (o: Partial<Sub> = {}): Sub => ({ status: "ACTIVE", currentPeriodStart: at(-20), currentPeriodEnd: at(10), cancelAtPeriodEnd: false, ...o });

describe("planChangeState", () => {
  it("결제한 기간 중이면 paidActive", () => {
    expect(planChangeState(null, sub(), NOW)).toEqual({ paidActive: true, pastDue: false, inTrial: false });
  });
  it("결제 실패(PAST_DUE)는 유예가 끝나 잠겨도 해지 전이면 pastDue", () => {
    expect(planChangeState(null, sub({ status: "PAST_DUE", currentPeriodStart: at(-40), currentPeriodEnd: at(-10) }), NOW)).toEqual({ paidActive: false, pastDue: true, inTrial: false });
  });
  it("결제한 기간 없이 체험 중이면 inTrial", () => {
    expect(planChangeState(at(5), null, NOW)).toEqual({ paidActive: false, pastDue: false, inTrial: true });
    expect(planChangeState(at(5), sub({ currentPeriodStart: null, currentPeriodEnd: null }), NOW)).toMatchObject({ paidActive: false, inTrial: true });
  });
  it("결제한 기간이 있으면 체험 끝이 남아도 inTrial이 아니다", () => {
    expect(planChangeState(at(5), sub(), NOW)).toMatchObject({ paidActive: true, inTrial: false });
  });
  it("해지된 구독·첫 결제 전·잠김은 모두 거짓", () => {
    const none = { paidActive: false, pastDue: false, inTrial: false };
    expect(planChangeState(null, null, NOW)).toEqual(none);
    expect(planChangeState(null, sub({ status: "CANCELED" }), NOW)).toEqual(none);
    expect(planChangeState(at(-1), sub({ currentPeriodEnd: at(-1) }), NOW)).toEqual(none);
    // 해지 예약한 기간이 끝났으면(예약 실행 전) 끝난 구독으로 본다
    expect(planChangeState(null, sub({ status: "PAST_DUE", cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) }), NOW)).toEqual(none);
  });
});

describe("해지·해지 예약", () => {
  it("canCancelSubscription: 해지 전 구독만(이용 기간이 끝난 결제 실패 구독 포함)", () => {
    expect(canCancelSubscription(null)).toBe(false);
    expect(canCancelSubscription(sub())).toBe(true);
    expect(canCancelSubscription(sub({ status: "PAST_DUE", currentPeriodEnd: at(-10) }))).toBe(true);
    expect(canCancelSubscription(sub({ cancelAtPeriodEnd: true }))).toBe(false);
    expect(canCancelSubscription(sub({ status: "CANCELED" }))).toBe(false);
  });
  it("isCancelScheduled: 해지 예약 중이고 기간이 남았을 때만", () => {
    expect(isCancelScheduled(sub({ cancelAtPeriodEnd: true }), NOW)).toBe(true);
    expect(isCancelScheduled(sub({ cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) }), NOW)).toBe(false);
    expect(isCancelScheduled(sub({ cancelAtPeriodEnd: true, status: "CANCELED" }), NOW)).toBe(false);
    expect(isCancelScheduled(sub(), NOW)).toBe(false);
    expect(isEndedSubscription(sub({ cancelAtPeriodEnd: true, currentPeriodEnd: at(-1) }), NOW)).toBe(true);
  });
});

describe("cardRegistrationCharges", () => {
  it("결제한 기간 중·결제 실패가 아닌 체험 중이면 카드만 등록(결제 없음)", () => {
    expect(cardRegistrationCharges(null, sub(), NOW)).toBe(false);
    expect(cardRegistrationCharges(at(5), null, NOW)).toBe(false);
    expect(cardRegistrationCharges(at(5), sub({ status: "CANCELED", currentPeriodEnd: null }), NOW)).toBe(false);
  });
  it("첫 결제 전·잠김·결제 실패(유예 중 포함)·체험 중 결제 실패는 바로 결제", () => {
    expect(cardRegistrationCharges(null, null, NOW)).toBe(true);
    expect(cardRegistrationCharges(at(-1), sub({ currentPeriodEnd: at(-1) }), NOW)).toBe(true);
    expect(cardRegistrationCharges(null, sub({ status: "PAST_DUE", currentPeriodEnd: at(-2) }), NOW)).toBe(true);
    expect(cardRegistrationCharges(at(5), sub({ status: "PAST_DUE", currentPeriodEnd: null }), NOW)).toBe(true);
  });
});
