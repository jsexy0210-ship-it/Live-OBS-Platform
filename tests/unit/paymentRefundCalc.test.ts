import { describe, expect, it } from "vitest";
import { computeRefundStep, earnRevokeStep, itemValue, type RefundCalcItem } from "../../lib/server/payments/refundCalc";
import { computeRefund } from "../../lib/server/queue/service";

// 결정적 난수(시험이 매번 같은 값을 쓰게)
function rng(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}
const NO_HISTORY = { itemsAmount: 0, cash: 0, rewardReturn: 0 };

function randomOrder(r: () => number) {
  const n = 1 + Math.floor(r() * 3);
  const items: RefundCalcItem[] = Array.from({ length: n }, (_, k) => {
    const quantity = 1 + Math.floor(r() * 4);
    const unitPrice = 1000 * (1 + Math.floor(r() * 9));
    return { id: `i${k}`, unitPrice, quantity, couponDiscount: r() < 0.4 ? Math.floor(r() * unitPrice * quantity * 0.3) : 0, opened: r() < 0.3, refundedQuantity: 0, select: 0 };
  });
  const ordered = items.reduce((a, i) => a + itemValue(i, i.quantity), 0);
  const shippingFee = r() < 0.3 ? 0 : 3000;
  const rewardUsed = r() < 0.5 ? Math.min(Math.floor((ordered - 10) / 10) * 10, 1000 + 10 * Math.floor(r() * 300)) : 0;
  return {
    items,
    shippingFee,
    totalAmount: ordered + shippingFee - Math.max(0, rewardUsed),
    shipped: r() < 0.5,
    fault: (r() < 0.5 ? "BUYER" : "SELLER") as "BUYER" | "SELLER",
    returnFee: 3000,
    rewardUsed: Math.max(0, rewardUsed),
  };
}

describe("부분 환불 계산", () => {
  it("남은 품목 전부를 한 번에 고르면 지금까지의 한 번 환불(computeRefund)과 금액이 같다(500가지)", () => {
    const r = rng(7);
    for (let t = 0; t < 500; t++) {
      const o = randomOrder(r);
      const all = o.items.map((i) => ({ ...i, select: i.quantity }));
      const step = computeRefundStep({ ...o, items: all, history: NO_HISTORY });
      const old = computeRefund({ ...o, items: o.items, rewardUsed: o.rewardUsed });
      expect({ refundAmount: step.refundAmount, returnFeeDeducted: step.returnFeeDeducted, rewardReturn: step.rewardReturn }, JSON.stringify(o)).toEqual(old);
      expect(step.isFinal).toBe(true);
    }
  });

  it("품목·수량을 나눠 여러 번 환불해도 상품 금액·적립금 반환 합은 한 번에 할 때와 같고, 현금 합은 결제 금액을 넘지 않는다(판매자 사정·발송 전, 500가지)", () => {
    const r = rng(11);
    for (let t = 0; t < 500; t++) {
      const o = { ...randomOrder(r), shipped: false, fault: "SELLER" as const };
      const once = computeRefundStep({ ...o, items: o.items.map((i) => ({ ...i, select: i.quantity })), history: NO_HISTORY });
      // 한 개씩 차례로 환불
      const items = o.items.map((i) => ({ ...i }));
      const history = { ...NO_HISTORY };
      let rounds = 0;
      for (const i of items) {
        for (let q = 0; q < i.quantity; q++) {
          const step = computeRefundStep({ ...o, items: items.map((x) => ({ ...x, select: x === i ? 1 : 0 })), history });
          expect(step.lines).toEqual([{ orderItemId: i.id, quantity: 1, amount: expect.any(Number) }]);
          history.itemsAmount += step.itemsAmount;
          history.cash += step.refundAmount;
          history.rewardReturn += step.rewardReturn;
          i.refundedQuantity += 1;
          rounds++;
          expect(step.isFinal).toBe(items.every((x) => x.refundedQuantity === x.quantity));
        }
      }
      expect(rounds).toBe(o.items.reduce((a, i) => a + i.quantity, 0));
      expect(history.itemsAmount, JSON.stringify(o)).toBe(once.itemsAmount);
      expect(history.rewardReturn).toBe(o.rewardUsed);
      expect(history.cash).toBe(once.refundAmount);
      expect(history.cash).toBeLessThanOrEqual(o.totalAmount);
      // 현금 + 적립금 반환 = 상품 + 배송비
      expect(history.cash + history.rewardReturn).toBe(once.itemsAmount + o.shippingFee);
    }
  });

  it("쿠폰 배분은 수량 비율로 내림하고 마지막 몫이 끝전을 가져간다", () => {
    const i = { unitPrice: 5000, quantity: 3, couponDiscount: 1000 };
    expect([1, 2, 3].map((n) => itemValue(i, n))).toEqual([5000 - 333, 10000 - 666, 15000 - 1000]);
    expect(itemValue(i, 1) + (itemValue(i, 2) - itemValue(i, 1)) + (itemValue(i, 3) - itemValue(i, 2))).toBe(14000);
  });

  it("배송비는 마지막 환불에서만, 반품 배송비는 발송 후 구매자 사정 환불마다 뺀다", () => {
    const base = { shippingFee: 3000, totalAmount: 18000, returnFee: 2500, rewardUsed: 0, history: NO_HISTORY };
    const items = (a: number, b: number): RefundCalcItem[] => [
      { id: "a", unitPrice: 5000, quantity: 2, couponDiscount: 0, opened: false, refundedQuantity: 0, select: a },
      { id: "b", unitPrice: 5000, quantity: 1, couponDiscount: 0, opened: false, refundedQuantity: 0, select: b },
    ];
    // 발송 전 일부: 배송비 없음, 반품 배송비 없음
    expect(computeRefundStep({ ...base, items: items(1, 0), shipped: false, fault: null })).toMatchObject({ itemsAmount: 5000, shippingRefunded: 0, refundAmount: 5000, isFinal: false });
    // 발송 전 마지막: 배송비 포함
    expect(computeRefundStep({ ...base, items: items(2, 1), shipped: false, fault: null })).toMatchObject({ shippingRefunded: 3000, refundAmount: 18000, isFinal: true });
    // 발송 후 구매자 사정 일부: 반품 배송비 뺌
    expect(computeRefundStep({ ...base, items: items(1, 0), shipped: true, fault: "BUYER" })).toMatchObject({ refundAmount: 2500, returnFeeDeducted: 2500 });
    // 발송 후 판매자 사정 일부: 반품 배송비 없음, 배송비는 마지막에만
    expect(computeRefundStep({ ...base, items: items(1, 0), shipped: true, fault: "SELLER" })).toMatchObject({ refundAmount: 5000, shippingRefunded: 0 });
    // 이미 돌려준 현금이 있으면 남은 결제 금액을 넘지 않는다
    expect(computeRefundStep({ ...base, items: items(2, 1), shipped: false, fault: null, history: { itemsAmount: 0, cash: 17000, rewardReturn: 0 } })).toMatchObject({ refundAmount: 1000 });
  });

  it("적립금 반환은 누적 비율로 10원 내림, 마지막 환불이 남은 전액", () => {
    const base = { shippingFee: 0, totalAmount: 12000 - 3010, returnFee: 0, rewardUsed: 3010, shipped: false, fault: null };
    const mk = (r: number[], s: number[]): RefundCalcItem[] => [
      { id: "a", unitPrice: 5000, quantity: 1, couponDiscount: 0, opened: false, refundedQuantity: r[0], select: s[0] },
      { id: "b", unitPrice: 7000, quantity: 1, couponDiscount: 0, opened: false, refundedQuantity: r[1], select: s[1] },
    ];
    const first = computeRefundStep({ ...base, items: mk([0, 0], [1, 0]), history: NO_HISTORY });
    expect(first).toMatchObject({ rewardReturn: 1250, refundAmount: 5000 - 1250 });
    const last = computeRefundStep({ ...base, items: mk([1, 0], [0, 1]), history: { itemsAmount: 5000, cash: first.refundAmount, rewardReturn: 1250 } });
    expect(last).toMatchObject({ rewardReturn: 3010 - 1250, refundAmount: 7000 - 1760, isFinal: true });
    expect(first.refundAmount + last.refundAmount).toBe(base.totalAmount);
  });

  it("주문 적립 회수: 누적 수량의 적립 기준액 비율로 내림, 마지막은 남은 전부", () => {
    const items = [
      { unitPrice: 5000, quantity: 2, refundedQuantity: 0, select: 1 },
      { unitPrice: 2000, quantity: 1, refundedQuantity: 0, select: 0 },
    ];
    expect(earnRevokeStep({ earnTotal: 121, items, isFinal: false, revokedBefore: 0 })).toBe(Math.floor((121 * 5000) / 12000));
    expect(earnRevokeStep({ earnTotal: 121, items: [{ ...items[0], refundedQuantity: 1, select: 1 }, { ...items[1], select: 1 }], isFinal: true, revokedBefore: 50 })).toBe(71);
    expect(earnRevokeStep({ earnTotal: 0, items, isFinal: true, revokedBefore: 0 })).toBe(0);
  });
});
