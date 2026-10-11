"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../components/seller/States";
import "../../../../components/seller/stats/stats.css";
import { BarChart, Kpis, bucketLabel, count, pct, type Kpi } from "../../../../components/seller/stats/parts";
import { adminCan } from "../../../../lib/server/authz/permissions";
import { allPeriodHref } from "../../../../lib/client/filterDefaults";
import { adminApi } from "./api";
import { AdminTopbar, useAdmin } from "./AdminShell";
import { dayTime, won } from "./partners";
import { type Monitor } from "./ops";
import { actionLabel, ACTOR_LABEL, targetLabel, type AuditRow } from "./auditLogs";
import "../(shell)/home.css";

// MA-001: 홈은 매출·업무 요약, 상세 현황은 기존 모든 조회 블록을 보존한다.
// IA 필수 업무큐·최고관리자 인프라는 보존한다. 지표·감시·로그는 각 GET/권한으로 독립 조회한다.
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

type Fetch<T> = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: T };
function useApi<T>(path: string, tick: number) {
  const [state, setState] = useState<Fetch<T>>({ kind: "loading" });
  const reqId = useRef(0);
  const pending = useRef<{ path: string; id: number } | null>(null);
  const load = useCallback(async () => {
    // 같은 조회가 진행 중이면 주기·수동 갱신이 앞선 응답을 굶기지 않도록 합친다.
    if (pending.current?.path === path) return;
    const id = ++reqId.current;
    pending.current = { path, id };
    setState({ kind: "loading" });
    const r = await adminApi<T>(path);
    if (id !== reqId.current) return;
    pending.current = null;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, [path]);
  useEffect(() => () => {
    // 기간 변경·화면 이탈 뒤 도착한 이전 조회는 현재 상태를 덮지 않는다.
    reqId.current++;
    pending.current = null;
  }, [path]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load, tick]);
  return [state, load] as const;
}

function Panel<T>({ title, state, retry, children, id, href }: { title: string; state: Fetch<T>; retry: () => void; children: (d: T) => React.ReactNode; id: string; href?: string }) {
  return (
    <section className="card pad col ma-home-panel" style={{ gap: 10 }} aria-label={title} data-testid={id}>
      <h2 className="t-hl1">{href ? <Link href={href}>{title}</Link> : title}</h2>
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
type Tasks = { at: string; total: number; items: { key: TaskKey; count: number; href: string; fields?: string[] }[] };
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
// 「10/5 (월) 15:45」
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
function shortAt(iso: string): string {
  const k = new Date(new Date(iso).getTime() + 9 * 3_600_000);
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} (${WEEK[k.getUTCDay()]}) ${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`;
}

function TodayTasks({ tick }: { tick: number }) {
  const [state, load] = useApi<Tasks>("/api/admin/today-tasks", tick);
  const { me } = useAdmin();
  const canEditInfo = adminCan(me.role, "system.manage");
  return (
    <Panel title="오늘 처리할 일" state={state} retry={() => void load()} id="today-tasks">
      {(d) => (
        <>
          <span className="t-c1 c-alt" data-testid="today-tasks-at">
            숫자를 누르면 해당 조건이 걸린 목록으로 이동합니다 · {shortAt(d.at)} 집계
          </span>
          {d.total === 0 && (
            <div className="card pad t-l2 c-alt" role="status" data-testid="today-tasks-empty">
              지금 처리할 일이 없습니다.
            </div>
          )}
          <div className="stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {d.items
              // 플랫폼 정보 미입력은 한 항목이라도 비어 있을 때만 보이고 모두 채우면 사라진다(MA-088 정본)
              .filter((t) => t.key !== "platformInfoMissing" || t.count > 0)
              .map((t) => {
                const isInfo = t.key === "platformInfoMissing";
                const unit = isInfo ? "항목" : "건";
                const body = (
                  <>
                    <span className="t-l2 c-alt">{TASK_LABEL[t.key]}</span>
                    <span className={`t-h2 ${t.count > 0 && !isInfo ? "c-neg" : ""}`}>{n(t.count, unit)}</span>
                    {isInfo && <span className="t-c1 c-alt">{(t.fields ?? []).map((f) => INFO_FIELD[f] ?? f).join(" · ")} 비어 있음</span>}
                    {isInfo && !canEditInfo && <span className="t-c1 c-alt">최고관리자에게 요청</span>}
                  </>
                );
                // 플랫폼 정보 화면은 최고관리자만 열 수 있어 다른 관리자에게는 누르는 타일이 아니라 안내로 보인다
                return isInfo && !canEditInfo ? (
                  <div key={t.key} className="card pad col" style={{ gap: 4 }} data-testid={`today-task-${t.key}`} aria-label={`${TASK_LABEL[t.key]} ${t.count}${unit}`}>
                    {body}
                  </div>
                ) : (
                  <Link key={t.key} href={taskHref(t.key, t.href)} className="card pad col" style={{ gap: 4, textDecoration: "none", color: "inherit" }} data-testid={`today-task-${t.key}`} aria-label={`${TASK_LABEL[t.key]} ${t.count}${unit}`}>
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
    <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
      <span className="t-c1 c-alt" style={{ width: 52 }}>{label}</span>
      <span style={{ width: 90, height: 8, borderRadius: 4, background: "var(--wds-fill-normal, #eee)", overflow: "hidden", display: "inline-block" }} aria-hidden="true">
        <i style={{ display: "block", height: "100%", width: `${Math.min(100, pct ?? 0)}%`, background: level }} />
      </span>
      <span>{pct === null ? "측정 전" : `${pct}%`}</span>
    </span>
  );
}
function InfraCard({ tick, compact = false }: { tick: number; compact?: boolean }) {
  const [state, setState] = useState<Fetch<InfraSummary>>({ kind: "loading" });
  const reqId = useRef(0);
  const pending = useRef(false);
  const load = useCallback(async () => {
    if (pending.current) return;
    const id = ++reqId.current;
    pending.current = true;
    const r = await adminApi<InfraSummary>("/api/admin/infra/summary");
    if (id !== reqId.current) return;
    pending.current = false;
    setState((prev) => (r.ok ? { kind: "ok", data: r.data } : prev.kind === "ok" ? prev : { kind: "error" }));
  }, []);
  useEffect(() => () => {
    reqId.current++;
    pending.current = false;
  }, []);
  // 1분마다 갱신(카드 정본: 「1분마다 갱신」). 새로 고침 버튼(tick)도 다시 부른다.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load, tick]);
  if (compact) return <Panel title="인프라 · 비용" state={state} retry={() => void load()} id="infra-card" href="/admin/ops/infra">{(d) => <>
    <div className="ma-home-compact-values"><span>이번 달 요금 <b data-testid="infra-card-cost">{d.cost.accruedWon === null ? "측정 전" : won(d.cost.accruedWon)}</b></span><span>월말 예상 {d.cost.projectedWon === null ? "측정 전" : won(d.cost.projectedWon)}</span><span>경고 <b data-testid="infra-card-warnings">{n(d.warnings.total, "건")}</b></span></div>
    <span className="t-c1 c-alt">{d.servers.length ? d.servers.map((s) => `${s.instance} 디스크 ${s.diskPct === null ? "측정 전" : s.diskPct + "%"} · 메모리 ${s.memoryPct === null ? "측정 전" : s.memoryPct + "%"}`).join(" / ") : "서버: 측정 전"} · 1분마다 갱신 · 요금 추정</span>
  </>}</Panel>;
  return (
    <section className="col" style={{ gap: 10 }} aria-label="인프라 · 비용" data-testid="infra-card">
      <h2 className="t-hl1">인프라 · 비용</h2>
      <span className="t-c1 c-alt">최고관리자에게만 보입니다 · 1분마다 갱신 · 카드를 누르면 「인프라 · 비용」으로 갑니다</span>
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
        <Link href="/admin/ops/infra" className="card pad" style={{ textDecoration: "none", color: "inherit", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
          <div className="col" style={{ gap: 6 }}>
            <span className="t-l2 c-alt">서버 디스크 · 메모리</span>
            {state.data.servers.length === 0 && <span className="c-alt">측정 전</span>}
            {state.data.servers.map((sv) => (
              <div key={sv.instance} className="col" style={{ gap: 2 }}>
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
              <span key={k} className="t-c1">{label} {state.data.warnings[k]}</span>
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
const pts = <P extends { bucket: string }>(series: P[], unit: "day" | "month", pick: (p: P) => number) => series.map((p) => ({ label: bucketLabel(p.bucket.length === 7 ? `${p.bucket}-01` : p.bucket, unit), value: pick(p) }));

function RevenueLine({ points }: { points: { label: string; value: number }[] }) {
  if (points.length === 0) return <p className="c-alt">이 기간에 집계된 결제가 없습니다.</p>;
  const high = Math.max(1, ...points.map((p) => p.value));
  const low = Math.min(0, ...points.map((p) => p.value));
  const xy = points.map((p, i) => ({ ...p, x: 24 + i * 552 / Math.max(1, points.length - 1), y: 160 - (p.value - low) * 140 / (high - low) }));
  return <figure className="ma-home-line">
    <svg viewBox="0 0 600 180" role="img" aria-label="일별 환불을 뺀 결제 금액 추이">
      <path d="M24 20H576M24 90H576M24 160H576" stroke="var(--wds-line-normal-alternative)" fill="none" />
      <path d={xy.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--wds-primary-normal)" strokeWidth="3" />
      {xy.map((p) => <circle key={p.label} cx={p.x} cy={p.y} r="4" fill="var(--wds-primary-normal)"><title>{p.label}: {wonF(p.value)}</title></circle>)}
    </svg>
    <figcaption className="t-c1 c-alt">{points[0].label} ~ {points[points.length - 1].label} · 환불을 뺀 결제 금액</figcaption>
    <details><summary>날짜별 금액 보기</summary><table className="tbl"><thead><tr><th>날짜</th><th>결제 금액</th></tr></thead><tbody>{points.map((p) => <tr key={p.label}><td>{p.label}</td><td>{wonF(p.value)}</td></tr>)}</tbody></table></details>
  </figure>;
}

function PeriodStats({ days, tick, summary, reload }: { days: number; tick: number; summary: Load; reload: () => void }) {
  const q = daysQuery(days);
  const [orders, loadOrders] = useApi<OrderStats>(`/api/admin/stats/orders?${q}&unit=day`, tick);
  const [growth, loadGrowth] = useApi<GrowthStats>(`/api/admin/stats/growth?${q}&unit=day`, tick);
  const [top, loadTop] = useApi<Top>(`/api/admin/stats/top-sellers?${q}`, tick);
  return (
    <>
      <div className="ma-home-kpis">
        <Panel title="전체 파트너스" state={summary} retry={reload} id="home-kpi-sellers" href="/admin/partners">{(d) => <><strong className="t-h2" data-testid="dash-sellers-total">{n(d.sellers.total, "곳")}</strong><span className="t-c1 c-alt">운영 중 {n(d.sellers.ACTIVE, "곳")} · 승인 대기 {n(d.sellers.PENDING, "곳")}</span>{d.sellers.total === 0 && <p className="c-alt">아직 파트너스가 없습니다. 가입 신청이 들어오면 여기와 알림에 표시됩니다.</p>}</>}</Panel>
        <Panel title="지금 방송 중" state={summary} retry={reload} id="home-kpi-live" href="/admin/ops/live">{(d) => <strong className="t-h2" data-testid="dash-live">{n(d.liveBroadcasts, "곳")}</strong>}</Panel>
        <Panel title="기간 주문" state={orders} retry={() => void loadOrders()} id="home-kpi-orders" href="/admin/ops/access">{(d) => <><Kpis items={[kpi("들어온 주문", d.current.orders, d.previous.orders, cntF)]} />{summary.kind === "ok" && <span className="t-c1 c-alt">오늘 <span data-testid="dash-orders-created">{n(summary.data.ordersToday.created, "건")}</span> · 결제된 주문 <span data-testid="dash-orders-paid">{n(summary.data.ordersToday.paid, "건")}</span></span>}</>}</Panel>
        <Panel title="기간 결제 금액" state={orders} retry={() => void loadOrders()} id="home-kpi-revenue">{(d) => <><Kpis items={[kpi("환불을 뺀 결제 금액", d.current.netRevenue, d.previous.netRevenue, wonF)]} />{summary.kind === "ok" && <span className="t-c1 c-alt">오늘 <span data-testid="dash-orders-amount">{won(summary.data.ordersToday.paidAmount)}</span></span>}</>}</Panel>
        <Panel title="구독 이용 중" state={summary} retry={reload} id="home-kpi-subscription" href="/admin/billing/subscriptions">{(d) => <><strong className="t-h2" data-testid="dash-sub-paid">{n(d.subscriptions.paid, "곳")}</strong><span className="t-c1 c-alt">결제 진행 중 {n(d.subscriptions.charging, "곳")} · 체험 {n(d.subscriptions.trial, "곳")}</span></>}</Panel>
        <Panel title="연체" state={summary} retry={reload} id="home-kpi-grace" href="/admin/billing/subscriptions">{(d) => <strong className="t-h2" data-testid="dash-sub-grace">{n(d.subscriptions.grace, "곳")}</strong>}</Panel>
      </div>
      <div className="ma-home-grid">
      <Panel title="결제 금액 추이" state={orders} retry={() => void loadOrders()} id="stats-orders">
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
            <RevenueLine points={pts(d.series, "day", (p) => p.netRevenue)} />
          </>
        )}
      </Panel>
      <Panel title="주문 추이" state={orders} retry={() => void loadOrders()} id="stats-order-series">{(d) => <><span className="t-c1 c-alt">들어온 주문 · 결제된 주문</span><BarChart title="일별 들어온 주문" points={pts(d.series, "day", (p) => p.orders)} fmt={count} bare /><BarChart title="일별 결제된 주문" points={pts(d.series, "day", (p) => p.paidOrders)} fmt={count} bare /></>}</Panel>
      <SubscriptionRevenue tick={tick} />
      <Panel title="신규 가입 신청 · 방송 수" state={growth} retry={() => void loadGrowth()} id="stats-growth">
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
      <Panel title="매출 상위 파트너스 5" state={top} retry={() => void loadTop()} id="stats-top">
        {(d) =>
          d.rows.length === 0 ? (
            <div className="card">
              <div className="st">
                <span className="t">이 기간에 결제된 주문이 없습니다.</span>
              </div>
            </div>
          ) : (
            <div className="card" style={{ overflowX: "auto" }}>
              <div className="ma-home-ranks">{d.rows.map((r) => <div key={r.sellerId}><Link href={`/admin/partners/${r.sellerId}`}>{r.rank}. {r.shopName}</Link><span>{wonF(r.netRevenue)}</span><progress aria-label={`${r.shopName} 환불을 뺀 결제 금액`} value={Math.max(0, r.netRevenue)} max={Math.max(1, ...d.rows.map((v) => v.netRevenue))} /></div>)}</div>
              <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>쇼핑몰</th>
                    <th>주문</th>
                    <th>결제된 주문</th>
                    <th>결제 금액</th>
                    <th>환불 금액</th>
                    <th>환불을 뺀 매출</th>
                    <th>전체에서 차지하는 비율</th>
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
      <Panel title="파트너스 상태" state={summary} retry={reload} id="home-seller-status">{(d) => <><Link href="/admin/partners">파트너스 목록</Link><StatusList total={d.sellers.total} items={[["운영 중", d.sellers.ACTIVE, "dash-sellers-active"], ["가입 신청 중", d.sellers.PENDING, "dash-sellers-pending"], ["이용 정지", d.sellers.SUSPENDED, "dash-sellers-suspended"], ["반려", d.sellers.REJECTED, "dash-sellers-rejected"], ["해지", d.sellers.CLOSED, "dash-sellers-closed"]]} /></>}</Panel>
      <Panel title="구독 상태" state={summary} retry={reload} id="home-subscription-status">{(d) => <><Link href="/admin/billing/subscriptions">구독 현황</Link><StatusList items={[["무료 체험 중", d.subscriptions.trial, "dash-sub-trial"], ["이용 중", d.subscriptions.paid, ""], ["결제 진행 중", d.subscriptions.charging, "dash-sub-charging"], ["연체", d.subscriptions.grace, ""], ["해지", d.subscriptions.expired, "dash-sub-expired"]]} /></>}</Panel>
      <MonthBilling tick={tick} />
      <OperationsPanels tick={tick} />
      </div>
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
              kpi("받은 구독료", d.current.revenue, d.previous.revenue, wonF),
              kpi("구독료 받은 비율", d.current.collectionRate, d.previous.collectionRate, pct),
              kpi("결제 실패", d.current.failed, d.previous.failed, cntF, true),
              kpi("환불 금액", d.current.refundAmount, d.previous.refundAmount, wonF, true),
            ]}
          />
          <BarChart title="월별 받은 구독료" points={pts(d.series, "month", (p) => p.revenue)} fmt={wonF} />
        </>
      )}
    </Panel>
  );
}

function StatusList({ total, items }: { total?: number; items: [string, number, string][] }) {
  const sum = total ?? items.reduce((v, row) => v + row[1], 0);
  const colors = ["var(--wds-primary-normal)", "var(--wds-status-positive)", "var(--wds-status-cautionary)", "var(--wds-status-negative)", "var(--wds-label-alternative)"];
  let offset = 0;
  const stops = items.map((row, i) => { const from = offset; offset += sum ? row[1] / sum * 100 : 0; return `${colors[i % colors.length]} ${from}% ${offset}%`; });
  return <div className="ma-home-status">
    <div className="ma-home-donut" role="img" aria-label={`상태별 전체 ${sum}곳`} style={{ background: sum ? `conic-gradient(${stops.join(",")})` : "var(--wds-line-normal-alternative)" }}><span>{n(sum, "곳")}</span></div>
    <ul>{items.map(([label, value, id]) => <li key={label}><span>{label}</span><b {...(id ? { "data-testid": id } : {})}>{n(value, "곳")}</b></li>)}</ul>
  </div>;
}

function MonthBilling({ tick }: { tick: number }) {
  const today = kst(Date.now());
  const [state, load] = useApi<SubStats>(`/api/admin/stats/subscriptions?from=${today.slice(0, 7)}-01&to=${today}`, tick);
  return <Panel title="이번 달 청구 결과" state={state} retry={() => void load()} id="home-month-billing">{(d) => <>
    <span className="t-c1 c-alt">{today.slice(0, 7)} · 서버 집계 기준</span>
    <Link href="/admin/billing/invoices">청구 · 결제 내역</Link>
    <dl className="ma-home-values">{[["결제 완료", count(d.current.paid)], ["결제 실패", count(d.current.failed)], ["결제 진행 중", count(d.current.pending)], ["받은 구독료", wonF(d.current.revenue)], ["환불 금액", wonF(d.current.refundAmount)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {d.current.paid + d.current.failed + d.current.pending === 0 && <p className="c-alt">이번 달 청구가 아직 없습니다.</p>}
  </>}</Panel>;
}

type Metrics = { checkedAt: string; db: { latencyMs: number; connections: { total: number; active: number; idle: number; idleInTransaction: number; waitingLock: number; max: number } }; queueBacklog: "not_measured" };
function DatabaseMetrics({ tick }: { tick: number }) {
  const [state, load] = useApi<Metrics>("/api/admin/ops/metrics", tick);
  return <Panel title="DB 응답 · 연결" state={state} retry={() => void load()} id="home-db-metrics">{(d) => <>
    <span>DB 응답 {d.db.latencyMs}ms</span>
    <span>DB 연결 {d.db.connections.total} / {d.db.connections.max}</span>
    <span className="t-c1 c-alt">작업 중 {d.db.connections.active} · 대기 {d.db.connections.idle} · 잠금 대기 {d.db.connections.waitingLock}</span>
    <span className="t-c1 c-alt">대기열 길이: 측정 안 함</span>
    <span className="t-c1 c-alt">{dayTime(d.checkedAt)} 기준</span>
  </>}</Panel>;
}
function RecentActivity({ tick }: { tick: number }) {
  const [state, load] = useApi<{ logs: AuditRow[] }>("/api/admin/audit-logs?limit=5&actorType=PLATFORM_ADMIN", tick);
  return <Panel title="최근 관리자 활동 (로그 추적)" state={state} retry={() => void load()} id="home-admin-activity">{(d) => <>
    <Link href="/admin/logs">로그 추적 전체</Link>
    {d.logs.length === 0 ? <p className="c-alt">관리자 활동이 아직 없습니다.</p> : <div className="ma-home-table"><table className="tbl"><thead><tr><th>시각</th><th>행위자</th><th>행위</th><th>대상 · 사유</th></tr></thead><tbody>{d.logs.map((r) => <tr key={r.id}><td>{dayTime(r.createdAt)}</td><td>{ACTOR_LABEL[r.actorType]}</td><td><Link href={`/admin/logs/${r.id}`}>{actionLabel(r.action)}</Link></td><td>{r.seller?.shopName ?? targetLabel(r.targetType)}{r.reason && ` · ${r.reason}`}</td></tr>)}</tbody></table></div>}
  </>}</Panel>;
}
function OperationsPanels({ tick }: { tick: number }) {
  const { me } = useAdmin();
  const [state, load] = useApi<Monitor>("/api/admin/ops/monitor", tick);
  const [severity, setSeverity] = useState("all");
  return <>
    <Panel title="운영 상태" state={state} retry={() => void load()} id="home-operations">{(d) => <>
      <Link href="/admin/ops/monitor">실시간 감시</Link>
      <span>{d.servers.total ? `서비스 서버 ${d.servers.healthy} / ${d.servers.total} 정상` : "서비스 서버: 측정 전"}</span>
      <span className="t-c1 c-alt">자동 연결 대기 {count(d.queue.automationQueued)} · {dayTime(d.at)} 기준</span>
      {d.jobs.length === 0 ? <p className="c-alt">정기 작업 신호가 아직 없습니다.</p> : <div className="ma-home-table"><table className="tbl"><thead><tr><th>정기 작업</th><th>상태</th><th>마지막 실행</th><th>마지막 성공</th></tr></thead><tbody>{d.jobs.map((j) => <tr key={j.job}><td>{j.job}</td><td>{j.healthy ? "정상" : "확인 필요"}</td><td>{dayTime(j.lastRunAt)}</td><td>{j.lastOkAt ? dayTime(j.lastOkAt) : "신호 없음"}</td></tr>)}</tbody></table></div>}
    </>}</Panel>
    {adminCan(me.role, "system.manage") && <DatabaseMetrics tick={tick} />}
    <Panel title="열린 장애" state={state} retry={() => void load()} id="home-incidents">{(d) => <>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}><Link href="/admin/ops/monitor">실시간 감시 전체</Link><label>심각도 <select value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="all">전체</option><option value="critical">긴급</option><option value="warning">주의</option></select></label></div>
      {d.incidents.filter((i) => severity === "all" || i.severity === severity).length === 0 ? <p className="c-alt">열린 장애가 없습니다.</p> : <ul className="ma-home-events">{d.incidents.filter((i) => severity === "all" || i.severity === severity).map((i) => <li key={`${i.source}:${i.key}`}><b>{i.severity === "critical" ? "긴급" : i.severity === "warning" ? "주의" : "정보"}</b><span>{i.message}</span><time>{dayTime(i.occurredAt)}</time></li>)}</ul>}
    </>}</Panel>
    {adminCan(me.role, "audit.read") && <RecentActivity tick={tick} />}
  </>;
}


function RevenueSummary({ days, tick }: { days: number; tick: number }) {
  const today = kst(Date.now());
  const [subscriptions, loadSubscriptions] = useApi<SubStats>(`/api/admin/stats/subscriptions?from=${today.slice(0, 7)}-01&to=${today}`, tick);
  const q = daysQuery(days);
  const [orders, loadOrders] = useApi<OrderStats>(`/api/admin/stats/orders?${q}&unit=day`, tick);
  return <div className="ma-home-revenue">
    <Panel title="플랫폼 구독 매출" state={subscriptions} retry={() => void loadSubscriptions()} id="home-revenue-subscriptions" href="/admin/settlement/collection">{(d) => <>
      <span className="t-c1 c-alt">{today.slice(0, 7)} · KST 월별 구독 청구·환불 집계</span>
      <Kpis items={[kpi("수납 구독료", d.current.revenue, d.previous.revenue, wonF), kpi("구독 환불", d.current.refundAmount, d.previous.refundAmount, wonF, true)]} />
    </>}</Panel>
    <Panel title="파트너스 주문 결제액" state={orders} retry={() => void loadOrders()} id="home-revenue-orders" href="/admin/home/status">{(d) => <>
      <span className="t-c1 c-alt">최근 {days}일 · {q.replace("from=", "").replace("&to=", " ~ ")} · KST 주문 생성일 기준</span>
      <Kpis items={[kpi("주문 결제액", d.current.revenue, d.previous.revenue, wonF), kpi("주문 환불", d.current.refundAmount, d.previous.refundAmount, wonF, true), kpi("환불 제외 결제액", d.current.netRevenue, d.previous.netRevenue, wonF)]} />
    </>}</Panel>
  </div>;
}
function CompactOperations({ tick, summary, reload }: { tick: number; summary: Load; reload: () => void }) {
  const { me } = useAdmin();
  const [monitor, loadMonitor] = useApi<Monitor>("/api/admin/ops/monitor", tick);
  return <div className="ma-home-brief">
    <Panel title="파트너스 · 구독" state={summary} retry={reload} id="home-brief-summary" href="/admin/home/status">{(d) => <>
      <div className="ma-home-compact-values"><Link href="/admin/partners">전체 파트너스 <b data-testid="dash-sellers-total">{n(d.sellers.total, "곳")}</b></Link><Link href="/admin/ops/live">방송 중 {n(d.liveBroadcasts, "곳")}</Link><Link href="/admin/billing/subscriptions">구독 이용 중 {n(d.subscriptions.paid, "곳")} · 연체 {n(d.subscriptions.grace, "곳")}</Link></div>
    </>}</Panel>
    <Panel title="운영 · 장애" state={monitor} retry={() => void loadMonitor()} id="home-brief-operations" href="/admin/ops/monitor">{(d) => <>
      <span>{d.servers.total ? `서비스 서버 ${d.servers.healthy} / ${d.servers.total} 정상` : "서비스 서버: 측정 전"} · 열린 장애 {count(d.incidents.length)} · 자동 연결 대기 {count(d.queue.automationQueued)}</span>
      <div className="ma-home-compact-values"><Link href="/admin/ops/automation">자동 연결 작업</Link>{adminCan(me.role, "system.manage") && <Link href="/admin/home/status">DB 응답 · 연결</Link>}{adminCan(me.role, "audit.read") && <Link href="/admin/logs">최근 관리자 활동 · 로그 추적</Link>}</div>
    </>}</Panel>
  </div>;
}

export default function HomeDashboard({ detail = false }: { detail?: boolean }) {
  const { me } = useAdmin();
  const isSuper = adminCan(me.role, "infra.manage");
  const [state, load] = useApi<Summary>("/api/admin/dashboard", 0);
  const [tick, setTick] = useState(0);
  const [days, setDays] = useState<number>(30);

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <AdminTopbar crumb={detail ? "홈 › 상세 현황" : "홈 › 통합 대시보드"} />
      <main className={`main ma-home ${detail ? "ma-home-detail" : "ma-home-compact"}`}>
        <PageHead
          title={detail ? "상세 현황" : "통합 대시보드"}
          description={detail ? "기간별 통계와 파트너스·구독·운영 상세 정보를 확인합니다." : "매출과 오늘 처리할 일을 확인합니다. 전체 정보는 홈의 상세 현황에서 확인합니다."}
          actions={
            <>
              <Link className="btn btn-out" href={detail ? "/admin" : "/admin/home/status"}>{detail ? "홈 요약" : "상세 현황"}</Link>
              {d && <span className="t-l2 c-alt">{dayTime(d.at)} 기준</span>}
              {d && <Link className="btn btn-out" href={taskHref("signupPending", "/admin/partners/applications")}>가입 신청 {d.sellers.PENDING}건 검토</Link>}
              <button className="btn btn-out" type="button" onClick={() => { setTick((t) => t + 1); void load(); }} disabled={state.kind === "loading"}>
                새로 고침
              </button>
            </>
          }
        />
        {!detail && <p className="ma-home-mobile-notice t-c1 c-alt" data-testid="admin-home-mobile-notice">모바일에서는 홈 화면을 제공합니다 상세 관리 업무는 PC에서 이용해 주십시오</p>}
        <div className="col ma-home-content">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <h2 className="t-hl1">{detail ? "기간별 현황" : "매출 요약"}</h2>
            <div className="row" style={{ gap: 6 }} role="group" aria-label="기간">
              {RANGES.map((r) => (
                <button key={r} type="button" className={`btn btn-sm ${days === r ? "" : "btn-out"}`} aria-pressed={days === r} onClick={() => setDays(r)}>
                  최근 {r}일
                </button>
              ))}
            </div>
          </div>
          {detail ? <>
            <PeriodStats days={days} tick={tick} summary={state} reload={() => void load()} />
            {isSuper && <InfraCard tick={tick} />}
          </> : <>
            <RevenueSummary days={days} tick={tick} />
            <TodayTasks tick={tick} />
            <CompactOperations tick={tick} summary={state} reload={() => void load()} />
            {isSuper && <InfraCard tick={tick} compact />}
          </>}
        </div>
      </main>
    </>
  );
}
