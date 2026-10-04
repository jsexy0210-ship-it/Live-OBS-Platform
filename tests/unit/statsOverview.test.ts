import { describe, expect, it } from "vitest";
import { overviewHasData } from "../../components/seller/stats/overview";

// 통계 요약의 빈 화면은 표시할 항목이 모두 비었을 때만(주문이 없어도 방송·적립금·비교값이 있으면 요약을 그린다)
const empty = {
  summary: { current: { orders: 0, excluded: 0, revenue: 0, signups: 0 }, previous: { orders: 0, excluded: 0, revenue: 0, signups: 0 } },
  broadcasts: { rows: [], general: { orders: 0 }, outside: { orders: 0 } },
  products: { total: { products: 0 }, unsoldCount: 0 },
  rewards: { earned: 0, revoked: 0, used: 0, expired: 0 },
  operations: { shipping: { shipped: 0 }, autoCancelled: 0 },
};

describe("overviewHasData", () => {
  it("모든 항목이 비면 false", () => {
    expect(overviewHasData(empty)).toBe(false);
  });
  it("주문이 없어도 방송·적립금·직전 기간 값·안 팔린 상품이 있으면 true", () => {
    expect(overviewHasData({ ...empty, broadcasts: { ...empty.broadcasts, rows: [{ id: "b" }] } })).toBe(true);
    expect(overviewHasData({ ...empty, rewards: { ...empty.rewards, earned: 100 } })).toBe(true);
    expect(overviewHasData({ ...empty, summary: { ...empty.summary, previous: { ...empty.summary.previous, revenue: 1000 } } })).toBe(true);
    expect(overviewHasData({ ...empty, products: { ...empty.products, unsoldCount: 3 } })).toBe(true);
  });
  it("직전 기간은 화면에 보이지 않는 값(취소·환불 제외 건수)만 있으면 빈 화면", () => {
    expect(overviewHasData({ ...empty, summary: { ...empty.summary, previous: { ...empty.summary.previous, excluded: 2 } } })).toBe(false);
    expect(overviewHasData({ ...empty, summary: { ...empty.summary, previous: { ...empty.summary.previous, orders: 1 } } })).toBe(true);
  });
});
