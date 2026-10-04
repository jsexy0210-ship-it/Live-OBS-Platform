// 통계 요약(SA-056)의 빈 화면 판정. 화면에 보이는 항목이 하나라도 있으면 요약을 그리고(주문 지표는 0), 모두 비었을 때만 「아직 집계할 주문이 없습니다」.
type Kpi = { orders: number; excluded: number; revenue: number; signups: number };
export type OverviewPresence = {
  summary: { current: Kpi; previous: Kpi };
  broadcasts: { rows: unknown[]; general: { orders: number }; outside: { orders: number } };
  products: { total: { products: number }; unsoldCount: number };
  rewards: { earned: number; revoked: number; used: number; expired: number };
  operations: { shipping: { shipped: number }; autoCancelled: number };
};

export function overviewHasData(d: OverviewPresence): boolean {
  const c = d.summary.current;
  const p = d.summary.previous;
  return (
    c.orders + c.excluded + c.signups > 0 ||
    c.revenue !== 0 ||
    // 직전 기간은 화면에 보이는 값(매출·주문·신규 회원)만 본다
    p.orders + p.signups > 0 ||
    p.revenue !== 0 ||
    d.broadcasts.rows.length > 0 ||
    d.broadcasts.general.orders + d.broadcasts.outside.orders > 0 ||
    d.products.total.products + d.products.unsoldCount > 0 ||
    d.rewards.earned + d.rewards.revoked + d.rewards.used + d.rewards.expired > 0 ||
    d.operations.shipping.shipped + d.operations.autoCancelled > 0
  );
}

// 요약의 방송 내역 표: 최근 방송 limit개는 그대로, 나머지는 「그 밖의 방송 N개」 한 줄로 묶는다.
// 보이는 줄 + 방송 시간 일반 주문 + 방송 외 주문 = 요약 매출이 되도록 나머지를 버리지 않는다.
export type BroadcastLine = { id: string; title: string | null; startedAt: string; orders: number; net: number; hits: number };
export function broadcastTable(rows: BroadcastLine[], limit: number) {
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit);
  return {
    shown,
    rest: rest.length === 0 ? null : { count: rest.length, orders: rest.reduce((a, r) => a + r.orders, 0), net: rest.reduce((a, r) => a + r.net, 0), hits: rest.reduce((a, r) => a + r.hits, 0) },
  };
}
