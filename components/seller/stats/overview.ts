// 통계 요약(SA-056)의 빈 화면 판정. 표시할 항목이 하나라도 있으면 요약을 그리고(주문 지표는 0), 모두 비었을 때만 「아직 집계할 주문이 없습니다」.
type Kpi = { orders: number; excluded: number; revenue: number; signups: number };
export type OverviewPresence = {
  summary: { current: Kpi; previous: Kpi };
  broadcasts: { rows: unknown[]; general: { orders: number }; outside: { orders: number } };
  products: { total: { products: number }; unsoldCount: number };
  rewards: { earned: number; revoked: number; used: number; expired: number };
  operations: { shipping: { shipped: number }; autoCancelled: number };
};

export function overviewHasData(d: OverviewPresence): boolean {
  const kpi = (k: Kpi) => k.orders + k.excluded + k.signups > 0 || k.revenue !== 0;
  return (
    kpi(d.summary.current) ||
    kpi(d.summary.previous) ||
    d.broadcasts.rows.length > 0 ||
    d.broadcasts.general.orders + d.broadcasts.outside.orders > 0 ||
    d.products.total.products + d.products.unsoldCount > 0 ||
    d.rewards.earned + d.rewards.revoked + d.rewards.used + d.rewards.expired > 0 ||
    d.operations.shipping.shipped + d.operations.autoCancelled > 0
  );
}
