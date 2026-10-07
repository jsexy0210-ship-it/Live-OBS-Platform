"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import "../../../../components/seller/stats/stats.css";
import "./dashboard.css";
import { BarChart, Kpis, bucketLabel, count, pct, type Kpi } from "../../../../components/seller/stats/parts";
import { adminCan } from "../../../../lib/server/authz/permissions";
import { formatDateTime } from "../../../../lib/client/format";
import { allPeriodHref } from "../../../../lib/client/filterDefaults";
import { adminApi } from "../_components/api";
import { AdminTopbar, useAdmin } from "../_components/AdminShell";
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
    <div className="admin-home-tile">
      <span className="t-l2 c-alt">{label}</span>
      <span className="t-h2" data-testid={id}>
        {value}
      </span>
    </div>
  );
}

function Section({ title, href, link, children }: { title: string; href?: string; link?: string; children: React.ReactNode }) {
  return (
    <section className="admin-home-section" aria-label={title}>
      <div className="admin-home-section-head">
        <h2 className="t-hl1">{title}</h2>
        {href && (
          <Link className="btn btn-sm btn-out" href={href}>
            {link}
          </Link>
        )}
      </div>
      <div className="admin-home-summary">
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

function Panel<T>({ title, state, retry, children, id, summary }: { title: string; state: Fetch<T>; retry: () => void; children: (d: T) => React.ReactNode; id: string; summary?: (d: T) => React.ReactNode }) {
  return (
    <section className="admin-home-section" aria-label={title} data-testid={id}>
      <div className="admin-home-section-head"><h2 className="t-hl1">{title}</h2>{state.kind === "ok" && summary?.(state.data)}</div>
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
type TaskKey = "signupPending" | "paymentFailed" | "refundRequested" | "inquiryOpen" | "pgError" | "automationFailed" | "incidentCritical" | "platformInfoMissing";
type Tasks = { at: string; total: number; items: { key: TaskKey; count: number; href: string; fields?: string[]; oldestAt?: string | null; overOneDay?: number }[] };
// 플랫폼 정보(MA-088) 빈 항목 이름
const INFO_FIELD: Record<string, string> = { name: "상호", representative: "대표자", businessNumber: "사업자등록번호", mailOrderNumber: "통신판매업 신고번호", address: "사업장 주소", phone: "고객센터 전화", email: "고객센터 이메일" };
const TASK_LABEL: Record<TaskKey, string> = {
  signupPending: "가입 신청 처리 대기",
  paymentFailed: "결제 실패",
  refundRequested: "환불 요청",
  inquiryOpen: "파트너스 문의",
  pgError: "카드 결제 연결 오류",
  automationFailed: "자동 연결 실패",
  incidentCritical: "바로 확인할 문제",
  platformInfoMissing: "플랫폼 정보 미입력",
};

// 「오늘 처리할 일」 숫자 링크: 업무 큐라 기간 전체로 들어간다(MASTER 공통 규칙, period=all). 결제 실패는 청구 화면의 최대 조회 기간(366일) 안에서 연다.
const KST_DAY = 86_400_000;
const kstDay = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
function taskHref(key: TaskKey, fallback: string): string {
  switch (key) {
    case "signupPending":
      return "/admin/partners/applications";
    case "paymentFailed":
      return `/admin/billing/invoices?failedOnly=1&from=${kstDay(Date.now() - 365 * KST_DAY)}&to=${kstDay(Date.now())}`;
    case "refundRequested":
      return allPeriodHref("/admin/billing/refunds", { status: "REQUESTED" });
    case "inquiryOpen":
      return allPeriodHref("/admin/support/inquiries", { status: "OPEN" });
    case "pgError":
      return allPeriodHref("/admin/settlement/pg");
    case "automationFailed":
      return allPeriodHref("/admin/ops/automation", { filter: "failed" });
    default:
      return fallback;
  }
}
function TodayTasks({ tick }: { tick: number }) {
  const [state, load] = useApi<Tasks>("/api/admin/today-tasks", tick);
  const { me } = useAdmin();
  const canEditInfo = adminCan(me.role, "system.manage");
  return (
    <Panel title="오늘 처리할 일" state={state} retry={() => void load()} id="today-tasks" summary={(d) => <span className="t-c1 c-alt" data-testid="today-tasks-at">숫자를 누르면 해당 조건이 걸린 목록으로 이동합니다 · {formatDateTime(d.at)} 집계</span>}>
      {(d) => (
        <>
          {d.total === 0 && (
            <div className="card pad t-l2 c-alt" role="status" data-testid="today-tasks-empty">
              지금 처리할 일이 없습니다.
            </div>
          )}
          <div className="admin-home-tasks">
            {d.items
              // 플랫폼 정보 미입력은 한 항목이라도 비어 있을 때만 보이고 모두 채우면 사라진다(MA-088 정본)
              .filter((t) => t.key !== "platformInfoMissing" || t.count > 0)
              .map((t) => {
                const isInfo = t.key === "platformInfoMissing";
                const unit = isInfo ? "항목" : t.key === "pgError" ? "곳" : "건";
                const body = (
                  <>
                    <span className="t-l2 c-alt">{TASK_LABEL[t.key]}</span>
                    <span className={`admin-home-task-value ${t.count > 0 && !isInfo ? "hot" : ""}`}>{n(t.count, unit)}</span>
                    {t.key === "signupPending" && t.oldestAt && <span className="t-c1 c-alt">가장 오래된 신청 {Math.floor((new Date(d.at).getTime() - new Date(t.oldestAt).getTime()) / KST_DAY) > 0 ? `${Math.floor((new Date(d.at).getTime() - new Date(t.oldestAt).getTime()) / KST_DAY)}일 전` : "오늘"}</span>}
                    {t.key === "inquiryOpen" && <span className="t-c1 c-alt">답변 대기 · 1일 넘음 {t.overOneDay ?? 0}</span>}
                    {isInfo && <span className="t-c1 c-alt">{(t.fields ?? []).map((f) => INFO_FIELD[f] ?? f).join(" · ")} 비어 있음</span>}
                    {isInfo && !canEditInfo && <span className="t-c1 c-alt">최고관리자에게 요청</span>}
                  </>
                );
                // 플랫폼 정보 화면은 최고관리자만 열 수 있어 다른 관리자에게는 누르는 타일이 아니라 안내로 보인다
                return isInfo && !canEditInfo ? (
                  <div key={t.key} className="admin-home-task" data-testid={`today-task-${t.key}`} aria-label={`${TASK_LABEL[t.key]} ${t.count}${unit}`}>
                    {body}
                  </div>
                ) : (
                  <Link key={t.key} href={taskHref(t.key, t.href)} className="admin-home-task" data-testid={`today-task-${t.key}`} aria-label={`${TASK_LABEL[t.key]} ${t.count}${unit}`}>
                    {body}
                  </Link>
                );
              })}
          </div>
        </>
      )}
    </Panel>
  );
}

// ─── 인프라 · 비용 요약 카드(최고관리자만, GET /api/admin/infra/summary) ───
type InfraSummary = {
  checkedAt: string;
  servers: { instance: string; takenAt: string; diskPct: number | null; memoryPct: number | null }[];
  cost: { month: string; estimated: boolean; accruedWon: number | null; projectedWon: number | null };
  warnings: { capacity: number; limitStopped: number; expiring30: number; expiring7: number; authError: number; total: number };
};
const WARN_LABEL: [keyof InfraSummary["warnings"], string][] = [
  ["capacity", "용량 기준 초과"],
  ["limitStopped", "한도 정지 기능"],
  ["authError", "외부 연결 인증 오류"],
  ["expiring7", "외부 연결 만료 7일 이내"],
  ["expiring30", "외부 연결 만료 30일 이내"],
];
function InfraBar({ label, pct }: { label: string; pct: number | null }) {
  const level = pct === null ? "" : pct >= 90 ? "var(--neg-text, #c0262c)" : pct >= 80 ? "var(--cau-text, #b25e00)" : "var(--wds-primary-normal, #0f766e)";
  return (
    <span className="admin-home-infra-meter" role="group" aria-label={label}>
      <span className="admin-home-infra-track" aria-hidden="true">
        <i style={{ display: "block", height: "100%", width: `${Math.min(100, pct ?? 0)}%`, background: level }} />
      </span>
      <span className="admin-home-infra-meter-value">{pct === null ? "측정 전" : `${pct}%`}</span>
    </span>
  );
}
function InfraCard({ tick }: { tick: number }) {
  const [state, setState] = useState<Fetch<InfraSummary>>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<InfraSummary>("/api/admin/infra/summary");
    if (id !== reqId.current) return;
    setState((prev) => (r.ok ? { kind: "ok", data: r.data } : prev.kind === "ok" ? prev : { kind: "error" }));
  }, []);
  // 1분마다 갱신(카드 정본: 「1분마다 갱신」). 새로 고침 버튼(tick)도 다시 부른다.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load, tick]);
  return (
    <section className="admin-home-section" aria-label="인프라 · 비용" data-testid="infra-card">
      <div className="admin-home-section-head"><h2 className="t-hl1">인프라 · 비용</h2><span className="t-c1 c-alt">최고관리자에게만 보입니다 · 1분마다 갱신 · 카드를 누르면 「인프라 · 비용」으로 갑니다</span><Link className="btn btn-sm btn-out" href="/admin/ops/infra">인프라 · 비용</Link></div>
      {state.kind === "loading" && (
        <div className="card">
          <LoadingRows rows={2} />
        </div>
      )}
      {state.kind === "error" && (
        <div className="card">
          <ErrorState title="인프라 · 비용을 불러오지 못했습니다." onRetry={() => void load()} />
        </div>
      )}
      {state.kind === "ok" && (
        <Link href="/admin/ops/infra" className="admin-home-infra">
          <div className="col" style={{ gap: 6 }}>
            <span className="t-l2 c-alt">서버 디스크 · 메모리</span>
            {state.data.servers.length === 0 && <span className="c-alt">측정 전</span>}
            {state.data.servers.map((sv) => (
              <div key={sv.instance} className="admin-home-infra-server">
                <b>{sv.instance}</b>
                <InfraBar label="디스크" pct={sv.diskPct} />
                <InfraBar label="메모리" pct={sv.memoryPct} />
              </div>
            ))}
            <span className="t-c1 c-alt">디스크 · 메모리 순 · 마지막 보고 {dayTime(state.data.servers[0]?.takenAt ?? state.data.checkedAt).slice(11)}</span>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="t-l2 c-alt">이번 달 요금 (추정)</span>
            <span className="t-h2" data-testid="infra-card-cost">{state.data.cost.accruedWon === null ? "측정 전" : won(state.data.cost.accruedWon)}</span>
            <span className="t-c1 c-alt">월말 예상 {state.data.cost.projectedWon === null ? "-" : won(state.data.cost.projectedWon)} · 승인 월 비용 안</span>
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="t-l2 c-alt">경고</span>
            <span className={`t-h2 ${state.data.warnings.total > 0 ? "c-neg" : ""}`} data-testid="infra-card-warnings">{n(state.data.warnings.total, "건")}</span>
            {WARN_LABEL.filter(([k]) => state.data.warnings[k] > 0).map(([k, label]) => (
              <span key={k} className="admin-home-warning">{label} {state.data.warnings[k]}</span>
            ))}
            <span className="t-c1 c-alt">기준 초과 · 한도 정지 · 외부 연결 만료 30일 · 7일 전 · 인증 오류</span>
          </div>
        </Link>
      )}
    </section>
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
const pts = <P extends { bucket: string }>(series: P[], unit: "day" | "month", pick: (p: P) => number) => series.map((p) => ({ label: unit === "day" ? bucketLabel(p.bucket, unit).slice(5) : bucketLabel(`${p.bucket}-01`, unit), value: pick(p) }));

function PeriodStats({ days, tick }: { days: number; tick: number }) {
  const q = daysQuery(days);
  const [orders, loadOrders] = useApi<OrderStats>(`/api/admin/stats/orders?${q}&unit=day`, tick);
  const [growth, loadGrowth] = useApi<GrowthStats>(`/api/admin/stats/growth?${q}&unit=day`, tick);
  const [top, loadTop] = useApi<Top>(`/api/admin/stats/top-sellers?${q}`, tick);
  return (
    <>
      <Panel title="주문 · 결제" state={orders} retry={() => void loadOrders()} id="stats-orders">
        {(d) => (
          <>
            <Kpis caption={`지난 ${days}일`}
              items={[
                kpi("결제 금액", d.current.revenue, d.previous.revenue, wonF),
                kpi("들어온 주문", d.current.orders, d.previous.orders, cntF),
                kpi("결제된 주문", d.current.paidOrders, d.previous.paidOrders, cntF),
              ]}
            />
            <div className="admin-home-charts">
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart compact title="일별 결제 금액 (만 원)" points={pts(d.series, "day", (p) => p.revenue / 10000)} fmt={(v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 1 })} />
              </div>
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart compact title="일별 들어온 주문" points={pts(d.series, "day", (p) => p.orders)} fmt={count} />
              </div>
            </div>
          </>
        )}
      </Panel>
      <Panel title="파트너스 성장" state={growth} retry={() => void loadGrowth()} id="stats-growth">
        {(d) => (
          <>
            <Kpis caption={`지난 ${days}일`} difference
              items={[
                kpi("가입 신청", d.current.signups, d.previous.signups, placeF),
                kpi("시작한 방송", d.current.broadcasts, d.previous.broadcasts, (v) => n(v, "회")),
              ]}
            />
            <div className="admin-home-charts">
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart compact title="일별 가입 신청" points={pts(d.series, "day", (p) => p.signups)} fmt={placeF} />
              </div>
              <div style={{ flex: "1 1 360px", minWidth: 0 }}>
                <BarChart compact title="일별 시작한 방송" points={pts(d.series, "day", (p) => p.broadcasts)} fmt={(v) => n(v, "회")} />
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
                    <th>파트너스</th>
                    <th>결제 금액</th>
                    <th>결제된 주문</th>
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
                      <td>{wonF(r.revenue)}</td>
                      <td>{cntF(r.paidOrders)}</td>
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
              { label: "받은 구독료 (6개월)", now: d.current.revenue, prev: null, fmt: wonF, compare: false, note: `월평균 ${wonF(Math.round(d.current.revenue / 6))}` },
            ]}
          />
          <BarChart compact title="월별 받은 구독료 (만 원)" points={pts(d.series, "month", (p) => p.revenue / 10000)} fmt={(v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 1 })} />
        </>
      )}
    </Panel>
  );
}

export default function AdminHome() {
  const { me } = useAdmin();
  const isSuper = adminCan(me.role, "infra.manage");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const tick = 0;
  const [days, setDays] = useState<number>(7);
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
      <main className="main admin-home">
        <PageHead
          title="통합 대시보드"
          actions={
            <>
              <Link className="btn btn-out" href="/admin/notifications">알림</Link>
              <Link className="btn" href="/admin/partners/applications">가입 신청 검토</Link>
            </>
          }
        />
        <div className="admin-home-body">
          <TodayTasks tick={tick} />
          {isSuper && <InfraCard tick={tick} />}
          {!d ? (
            <div className="card">
              {state.kind === "loading" && <LoadingRows rows={4} />}
              {state.kind === "error" && <ErrorState title="대시보드를 불러오지 못했습니다." onRetry={() => void load()} />}
            </div>
          ) : (
            <>
              <Section title="파트너스" href="/admin/partners" link="파트너스 목록">
                <Tile id="dash-sellers-active" label="운영 중" value={n(d.sellers.ACTIVE, "곳")} />
                <Tile id="dash-sellers-pending" label="가입 신청 중" value={n(d.sellers.PENDING, "곳")} />
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
                <Tile id="dash-sub-trial" label="무료 체험 중" value={n(d.subscriptions.trial, "곳")} />
                <Tile id="dash-sub-paid" label="이용 중" value={n(d.subscriptions.paid, "곳")} />
                <Tile id="dash-sub-charging" label="결제 진행 중" value={n(d.subscriptions.charging, "곳")} />
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
