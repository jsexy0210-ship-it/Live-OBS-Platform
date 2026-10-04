import { describe, expect, it } from "vitest";
import { broadcastTable, overviewHasData } from "../../components/seller/stats/overview";

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

describe("broadcastTable", () => {
  it("방송 7개면 최근 5개 + 「그 밖의 방송 2개」 줄이고, 보이는 줄 + 일반 주문 + 방송 외 = 요약 매출", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, title: null, startedAt: "2026-10-02T00:00:00Z", orders: 1, net: (i + 1) * 1000, hits: i }));
    const general = 500;
    const outside = 700;
    const revenue = rows.reduce((a, r) => a + r.net, 0) + general + outside;
    const t = broadcastTable(rows, 5);
    expect(t.shown).toHaveLength(5);
    expect(t.rest).toEqual({ count: 2, orders: 2, net: 13000, hits: 11 });
    expect(t.shown.reduce((a, r) => a + r.net, 0) + t.rest!.net + general + outside).toBe(revenue);
  });
  it("5개 이하면 묶음 줄이 없다", () => {
    expect(broadcastTable([], 5).rest).toBeNull();
  });
});
