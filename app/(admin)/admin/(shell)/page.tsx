"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import "../../../../components/seller/stats/stats.css";
import { BarChart, Kpis, bucketLabel, count, pct, type Kpi } from "../../../../components/seller/stats/parts";
import { adminApi } from "../_components/api";
import { AdminTopbar } from "../_components/AdminShell";
import { dayTime, won } from "../_components/partners";

// MA-001 통합 대시보드(모든 마스터 역할, 숫자만·조회만). 맨 위 「오늘 처리할 일」(GET /api/admin/today-tasks)은 숫자를 누르면 조건이 걸린 목록으로 간다.
// 그 아래 현황 칸(GET /api/admin/dashboard)과 기간별 주문·결제·구독 매출·성장·상위 5 파트너스(GET /api/admin/stats/*)는 각각 따로 불러와, 하나가 실패해도 나머지는 그대로 보인다.
// 서버가 주는 값만 보여 준다(없는 칸을 만들지 않는다).
type Summary = {
  at: string;
  sellers: { total: number; PENDING: number; ACTIVE: number; SUSPENDED: number; REJECTED: number; CLOSED: number };
  liveBroadcasts: number;
  ordersToday: { created: number; paid: number; paidAmount: number };
  subscriptions: { trial: number; paid: number; charging: number; grace: number; expired: number };
};
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Summary };
const n = (v: number, unit: string) => `${v.toLocaleString("ko-KR")}${unit}`;

function Tile({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="card pad col" style={{ gap: 4 }}>
      <span className="t-l2 c-alt">{label}</span>
      <span className="t-h2" data-testid={id}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, href, link, children }: { title: string; href?: string; link?: string; children: React.ReactNode }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-label={title}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 className="t-hl1">{title}</h2>
        {href && (
          <Link className="btn btn-sm btn-out" href={href}>
            {link}
          </Link>
        )}
      </div>
      <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        {children}
      </div>
    </section>
  );
}


type Fetch<T> = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: T };
function useApi<T>(path: string, tick: number) {
  const [state, setState] = useState<Fetch<T>>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<T>(path);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, [path]);
  useEffect(() => void load(), [load, tick]);
  return [state, load] as const;
}

function Panel<T>({ title, state, retry, children, id }: { title: string; state: Fetch<T>; retry: () => void; children: (d: T) => React.ReactNode; id: string }) {
  return (
    <section className="col" style={{ gap: 10 }} aria-label={title} data-testid={id}>
      <h2 className="t-hl1">{title}</h2>
      {state.kind === "loading" && (
        <div className="card">
          <LoadingRows rows={3} />
        </div>
      )}
      {state.kind === "error" && (
        <div className="card">
          <ErrorState title={`${title}을(를) 불러오지 못했습니다.`} onRetry={retry} />
        </div>
      )}
      {state.kind === "ok" && children(state.data)}
    </section>
  );
}

// ─── 오늘 처리할 일 ───
type TaskKey = "signupPending" | "paymentFailed" | "refundRequested" | "inquiryOpen" | "pgError" | "automationFailed" | "incidentCritical";
type Tasks = { at: string; total: number; items: { key: TaskKey; count: number; href: string }[] };
const TASK_LABEL: Record<TaskKey, string> = {
  signupPending: "가입 승인 대기",
  paymentFailed: "결제 실패",
  refundRequested: "환불 요청",
  inquiryOpen: "답변 대기 문의",
  pgError: "PG 연결 오류",
  automationFailed: "자동 연결 실패",
  incidentCritical: "심각 장애",
};

function TodayTasks({ tick }: { tick: number }) {
  const [state, load] = useApi<Tasks>("/api/admin/today-tasks", tick);
  return (
    <Panel title="오늘 처리할 일" state={state} retry={() => void load()} id="today-tasks">
      {(d) => (
        <>
          {d.total === 0 && (
            <div className="card pad t-l2 c-alt" role="status" data-testid="today-tasks-empty">
              지금 처리할 일이 없습니다.
            </div>
          )}
          <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {d.items.map((t) => (
              <Link key={t.key} href={t.href} className="card pad col" style={{ gap: 4, textDecoration: "none", color: "inherit" }} data-testid={`today-task-${t.key}`} aria-label={`${TASK_LABEL[t.key]} ${t.count}건`}>
                <span className="t-l2 c-alt">{TASK_LABEL[t.key]}</span>
                <span className={`t-h2 ${t.count > 0 ? "c-neg" : ""}`}>{n(t.count, "건")}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// ─── 기간별 통계 ───
type OrderSum = { orders: number; paidOrders: number; revenue: number; refundAmount: number; netRevenue: number };
type OrderStats = { current: OrderSum; previous: OrderSum; series: ({ bucket: string } & OrderSum)[] };
type Billing = { paid: number; failed: number; pending: number; revenue: number; refunds: number; refundAmount: number; netRevenue: number; collectionRate: number | null };
type SubStats = { current: Billing; previous: Billing; series: ({ bucket: string } & Billing)[] };
type Growth = { signups: number; approved: number; broadcasts: number; broadcasters: number };
type GrowthStats = { current: Growth; previous: Growth; series: ({ bucket: string } & Growth)[] };
type TopRow = { rank: number; sellerId: string; shopName: string; orders: number; paidOrders: number; revenue: number; refundAmount: number; netRevenue: number; share: number | null };
type Top = { rows: TopRow[] };

const DAY = 86_400_000;
const kst = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const RANGES = [7, 30, 90] as const;
const daysQuery = (days: number) => {
  const now = Date.now();
  return `from=${kst(now - (days - 1) * DAY)}&to=${kst(now)}`;
};
// 구독 매출은 월 단위라 최근 6개월(이번 달 포함)을 본다
const monthsQuery = () => {
  const [y, m] = kst(Date.now()).split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - 5, 1)).toISOString().slice(0, 10);
  return `from=${first}&to=${kst(Date.now())}`;
};
const kpi = (label: string, now: number | null, prev: number | null, fmt: (v: number) => string, lowerIsBetter?: boolean): Kpi => ({ label, now, prev, fmt, lowerIsBetter });
const wonF = (v: number) => `${v.toLocaleString("ko-KR")}원`;
const cntF = (v: number) => `${v.toLocaleString("ko-KR")}건`;
const placeF = (v: number) => `${v.toLocaleString("ko-KR")}곳`;
const pts = <P extends { bucket: string }>(series: P[], unit: "day" | "month", pick: (p: P) => number) => series.map((p) => ({ label: bucketLabel(p.bucket.length === 7 ? `${p.bucket}-01` : p.bucket, unit), value: pick(p) }));

function PeriodStats({ days, tick }: { days: number; tick: number }) {
  const q = daysQuery(days);
  const [orders, loadOrders] = useApi<OrderStats>(`/api/admin/stats/orders?${q}&unit=day`, tick);
  const [growth, loadGrowth] = useApi<GrowthStats>(`/api/admin/stats/growth?${q}&unit=day`, tick);
  const [top, loadTop] = useApi<Top>(`/api/admin/stats/top-sellers?${q}`, tick);
  return (
    <>
      <Panel title="주문·결제" state={orders} retry={() => void loadOrders()} id="stats-orders">
        {(d) => (
          <>
            <Kpis
              items={[
                kpi("결제 금액", d.current.revenue, d.previous.revenue, wonF),
                kpi("결제된 주문", d.current.paidOrders, d.previous.paidOrders, cntF),
                kpi("들어온 주문", d.current.orders, d.previous.orders, cntF),
                kpi("환불 금액", d.current.refundAmount, d.previous.refundAmount, wonF, true),
              ]}
            />
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart title="일별 결제 금액" points={pts(d.series, "day", (p) => p.revenue)} fmt={wonF} />
              </div>
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart title="일별 들어온 주문" points={pts(d.series, "day", (p) => p.orders)} fmt={count} />
              </div>
            </div>
          </>
        )}
      </Panel>
      <Panel title="파트너스 성장" state={growth} retry={() => void loadGrowth()} id="stats-growth">
        {(d) => (
          <>
            <Kpis
              items={[
                kpi("가입 신청", d.current.signups, d.previous.signups, placeF),
                kpi("승인", d.current.approved, d.previous.approved, placeF),
                kpi("시작한 방송", d.current.broadcasts, d.previous.broadcasts, cntF),
                kpi("방송한 파트너스", d.current.broadcasters, d.previous.broadcasters, placeF),
              ]}
            />
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "stretch" }}>
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart title="일별 가입 신청" points={pts(d.series, "day", (p) => p.signups)} fmt={placeF} />
              </div>
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart title="일별 시작한 방송" points={pts(d.series, "day", (p) => p.broadcasts)} fmt={cntF} />
              </div>
            </div>
          </>
        )}
      </Panel>
      <Panel title="상위 5 파트너스" state={top} retry={() => void loadTop()} id="stats-top">
        {(d) =>
          d.rows.length === 0 ? (
            <div className="card">
              <div className="st">
                <span className="t">이 기간에 결제된 주문이 없습니다.</span>
              </div>
            </div>
          ) : (
            <div className="card" style={{ overflowX: "auto" }}>
              <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>쇼핑몰</th>
                    <th>주문</th>
                    <th>결제된 주문</th>
                    <th>결제 금액</th>
                    <th>환불 금액</th>
                    <th>순매출</th>
                    <th>비중</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.sellerId} data-testid="top-seller-row">
                      <td>{r.rank}</td>
                      <td className="col-text">
                        <Link className="fw6" href={`/admin/partners/${r.sellerId}`}>
                          {r.shopName}
                        </Link>
                      </td>
                      <td>{r.orders.toLocaleString("ko-KR")}</td>
                      <td>{r.paidOrders.toLocaleString("ko-KR")}</td>
                      <td>{wonF(r.revenue)}</td>
                      <td>{wonF(r.refundAmount)}</td>
                      <td>{wonF(r.netRevenue)}</td>
                      <td>{pct(r.share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Panel>
    </>
  );
}

function SubscriptionRevenue({ tick }: { tick: number }) {
  const [state, load] = useApi<SubStats>(`/api/admin/stats/subscriptions?${monthsQuery()}`, tick);
  return (
    <Panel title="구독 매출 (최근 6개월)" state={state} retry={() => void load()} id="stats-subscriptions">
      {(d) => (
        <>
          <Kpis
            items={[
              kpi("수납 매출", d.current.revenue, d.previous.revenue, wonF),
              kpi("수납률", d.current.collectionRate, d.previous.collectionRate, pct),
              kpi("결제 실패", d.current.failed, d.previous.failed, cntF, true),
              kpi("환불 금액", d.current.refundAmount, d.previous.refundAmount, wonF, true),
            ]}
          />
          <BarChart title="월별 수납 매출" points={pts(d.series, "month", (p) => p.revenue)} fmt={wonF} />
        </>
      )}
    </Panel>
  );
}

export default function AdminHome() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [days, setDays] = useState<number>(30);
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Summary>("/api/admin/dashboard");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <AdminTopbar crumb="홈 › 통합 대시보드" />
      <main className="main">
        <PageHead
          title="통합 대시보드"
          actions={
            <>
              {d && <span className="t-l2 c-alt">{dayTime(d.at)} 기준</span>}
              <button className="btn btn-out" type="button" onClick={() => { setTick((t) => t + 1); void load(); }} disabled={state.kind === "loading"}>
                새로 고침
              </button>
            </>
          }
        />
        <div className="col" style={{ gap: 24 }}>
          <TodayTasks tick={tick} />
          {!d ? (
            <div className="card">
              {state.kind === "loading" && <LoadingRows rows={4} />}
              {state.kind === "error" && <ErrorState title="대시보드를 불러오지 못했습니다." onRetry={() => void load()} />}
            </div>
          ) : (
            <>
              <Section title="파트너스" href="/admin/partners" link="파트너스 목록">
                <Tile id="dash-sellers-active" label="운영 중" value={n(d.sellers.ACTIVE, "곳")} />
                <Tile id="dash-sellers-pending" label="승인 대기" value={n(d.sellers.PENDING, "곳")} />
                <Tile id="dash-sellers-suspended" label="이용 정지" value={n(d.sellers.SUSPENDED, "곳")} />
                <Tile id="dash-sellers-total" label="전체" value={n(d.sellers.total, "곳")} />
              </Section>
              <Section title="오늘">
                <Tile id="dash-live" label="지금 방송 중" value={n(d.liveBroadcasts, "곳")} />
                <Tile id="dash-orders-created" label="들어온 주문" value={n(d.ordersToday.created, "건")} />
                <Tile id="dash-orders-paid" label="결제된 주문" value={n(d.ordersToday.paid, "건")} />
                <Tile id="dash-orders-amount" label="결제 금액" value={won(d.ordersToday.paidAmount)} />
              </Section>
              <Section title="구독" href="/admin/billing/subscriptions" link="구독 현황">
                <Tile id="dash-sub-trial" label="체험" value={n(d.subscriptions.trial, "곳")} />
                <Tile id="dash-sub-paid" label="이용 중" value={n(d.subscriptions.paid, "곳")} />
                <Tile id="dash-sub-charging" label="결제 처리 중" value={n(d.subscriptions.charging, "곳")} />
                <Tile id="dash-sub-grace" label="연체" value={n(d.subscriptions.grace, "곳")} />
                <Tile id="dash-sub-expired" label="해지" value={n(d.subscriptions.expired, "곳")} />
              </Section>
            </>
          )}
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h2 className="t-hl1">기간별 현황</h2>
            <div className="row" style={{ gap: 6 }} role="group" aria-label="기간">
              {RANGES.map((r) => (
                <button key={r} type="button" className={`btn btn-sm ${days === r ? "" : "btn-out"}`} aria-pressed={days === r} onClick={() => setDays(r)}>
                  최근 {r}일
                </button>
              ))}
            </div>
          </div>
          <PeriodStats days={days} tick={tick} />
          <SubscriptionRevenue tick={tick} />
        </div>
      </main>
    </>
  );
}
