import { describe, expect, it } from "vitest";
import { invoiceRetryReason, RETRY_MIN_GAP_MS } from "../../lib/server/admin/billingInvoices";

const now = new Date("2026-10-07T00:00:00Z");
const pay = { id: "payment", status: "FAILED", scheduled: true, kind: "PERIOD" };
const latest = { id: pay.id, createdAt: new Date(now.getTime() - RETRY_MIN_GAP_MS) };
const sub = { status: "PAST_DUE", cancelAtPeriodEnd: false, billingKeyCipher: "test-only", seller: { status: "ACTIVE" } };

describe("기존 청구 재시도 순수 판정", () => {
  it.each(["ACTIVE", "PAST_DUE"])("%s 구독은 정확히 5분부터 가능하고 입력을 바꾸지 않는다", (status) => {
    const before = JSON.stringify([pay, latest, sub, now]);
    expect(invoiceRetryReason(pay, latest, { ...sub, status }, now)).toBeNull();
    expect(JSON.stringify([pay, latest, sub, now])).toBe(before);
  });
  it.each([
    [{ ...pay, status: "PAID" }, latest, sub, "not_failed"],
    [{ ...pay, status: "PENDING" }, latest, sub, "not_failed"],
    [pay, null, sub, "not_latest"],
    [pay, { ...latest, id: "newer" }, sub, "not_latest"],
    [{ ...pay, scheduled: false }, latest, sub, "not_latest"],
    [{ ...pay, kind: "PRORATION" }, latest, sub, "not_latest"],
    [pay, latest, { ...sub, status: "CANCELED" }, "not_retryable"],
    [pay, latest, { ...sub, cancelAtPeriodEnd: true }, "not_retryable"],
    [pay, latest, { ...sub, billingKeyCipher: null }, "not_retryable"],
    [pay, latest, { ...sub, billingKeyCipher: "" }, "not_retryable"],
    [pay, latest, { ...sub, seller: { status: "SUSPENDED" } }, "not_retryable"],
    [pay, { ...latest, createdAt: new Date(now.getTime() - RETRY_MIN_GAP_MS + 1) }, sub, "too_soon"],
    [pay, { ...latest, createdAt: new Date(now.getTime() + 1) }, sub, "too_soon"],
  ] as const)("기존 거부 사유와 순서를 보존한다", (payment, last, subscription, reason) => {
    expect(invoiceRetryReason(payment, last, subscription, now)).toBe(reason);
  });
  it("여러 거부 조건이 겹쳐도 실패상태→최신청구→구독→간격 순서를 유지한다", () => {
    expect(invoiceRetryReason({ ...pay, status: "PAID", scheduled: false }, null, { ...sub, billingKeyCipher: null }, now)).toBe("not_failed");
    expect(invoiceRetryReason({ ...pay, scheduled: false }, latest, { ...sub, billingKeyCipher: null }, now)).toBe("not_latest");
    expect(invoiceRetryReason(pay, { ...latest, createdAt: now }, { ...sub, billingKeyCipher: null }, now)).toBe("not_retryable");
  });
});
