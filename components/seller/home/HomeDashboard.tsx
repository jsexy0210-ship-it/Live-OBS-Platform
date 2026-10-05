"use client";

import "../stats/stats.css";
import "./home.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../admin-ui";
import { Topbar, useSeller } from "../SellerShell";
import { ErrorState, LoadingRows } from "../States";
import { api } from "../api";
import { kstDate, kstDuration, type BroadcastSummary } from "../broadcast/history";
import { won } from "../format";
import { kstToday } from "../stats/StatsFrame";
import { Kpis, count } from "../stats/parts";

// SA-002 파트너스 홈(쇼핑몰 통합 요금제). 오늘 처리할 일 → 성과(오늘) → 방송 순서(IA 개편, 대표님 지시 2026-10-05).
// API: GET /api/seller/today-tasks(항목별 권한이 없으면 서버가 뺀다), GET /api/seller/stats/overview?from=오늘&to=오늘(통계 권한),
//      GET /api/seller/broadcast/history(방송 권한). 권한이 없거나 막힌 구역은 가짜 값 없이 구역째 감춘다.
// 오버레이 전용 홈(SA-002-O)은 이 블록을 쓰지 않는다(화면-방송 담당). 공용 구역은 이 폴더의 컴포넌트로 가져다 쓴다.
type Task = { key: string; count: number; href: string };
type Tasks = { total: number; items: Task[] };
type Overview = {
  summary: { current: { revenue: number; orders: number; averageOrderValue: number | null }; previous: { revenue: number; orders: number; averageOrderValue: number | null } };
  operations: { cancelled: number; refunded: number; refundAmount: number };
};
type Broadcast = { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null; summary: BroadcastSummary };

const TASK_LABEL: Record<string, string> = {
  depositPending: "입금 확인",
  shipPending: "배송 준비",
  returnRequested: "반품 요청",
  inquiryWaiting: "문의 답변",
  stockOut: "재고 없음",
  stockLow: "재고 적음",
};
const BROADCAST_ROWS = 3;

type Part<T> = { kind: "loading" } | { kind: "hidden" } | { kind: "error" } | { kind: "ok"; data: T };

function usePart<T>(path: string, pick: (raw: never) => T, deps: unknown[] = []): [Part<T>, () => void] {
  const [state, setState] = useState<Part<T>>({ kind: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    void api<never>(path).then((r) => {
      if (!live) return;
      if (r.ok) setState({ kind: "ok", data: pick(r.data) });
      else setState({ kind: r.status === 403 || r.status === 402 ? "hidden" : "error" });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return [state, useCallback(() => setN((v) => v + 1), [])];
}

function Section({ title, sub, actions, children }: { title: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="home-sec">
      <div className="home-sec-h">
        <h2>
          {title} {sub && <span className="sub">{sub}</span>}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function TodayTasks() {
  const [part, retry] = usePart<Tasks>("/api/seller/today-tasks", (d) => d as Tasks);
  if (part.kind === "hidden") return null;
  return (
    <Section title="오늘 처리할 일" sub={part.kind === "ok" && part.data.total > 0 ? `${count(part.data.total)}` : undefined}>
      {part.kind === "loading" && <LoadingRows rows={2} />}
      {part.kind === "error" && <ErrorState title="처리할 일을 불러오지 못했습니다" onRetry={retry} />}
      {part.kind === "ok" &&
        (part.data.items.length === 0 ? (
          <div className="home-empty">확인할 수 있는 처리할 일이 없습니다</div>
        ) : (
          <>
            <div className="home-tasks" data-testid="home-tasks">
              {part.data.items.map((t) => (
                <Link key={t.key} href={t.href} className={`home-task${t.count === 0 ? " zero" : ""}`} data-testid={`home-task-${t.key}`}>
                  <span className="l">{TASK_LABEL[t.key] ?? t.key}</span>
                  <span className="v">{t.count.toLocaleString("ko-KR")}</span>
                </Link>
              ))}
            </div>
            {part.data.total === 0 && <div className="home-empty">지금 처리할 일이 없습니다</div>}
          </>
        ))}
    </Section>
  );
}

function Performance() {
  const today = kstToday();
  const [part, retry] = usePart<Overview>(`/api/seller/stats/overview?from=${today}&to=${today}`, (d) => d as Overview);
  if (part.kind === "hidden") return null;
  return (
    <Section title="오늘 성과" actions={<Link className="btn btn-out" href="/seller/stats">통계 보기</Link>}>
      {part.kind === "loading" && <LoadingRows rows={2} />}
      {part.kind === "error" && <ErrorState title="오늘 성과를 불러오지 못했습니다" onRetry={retry} />}
      {part.kind === "ok" && (
        <div data-testid="home-performance">
          <Kpis
            items={[
              { label: "매출(결제 기준)", now: part.data.summary.current.revenue, prev: part.data.summary.previous.revenue, fmt: won },
              { label: "주문", now: part.data.summary.current.orders, prev: part.data.summary.previous.orders, fmt: count },
              { label: "주문당 평균", now: part.data.summary.current.averageOrderValue, prev: part.data.summary.previous.averageOrderValue, fmt: won },
              {
                label: "취소 · 환불",
                now: null,
                prev: null,
                fmt: count,
                compare: false,
                text: `${count(part.data.operations.cancelled + part.data.operations.refunded)}`,
                note: part.data.operations.refundAmount > 0 ? `환불 ${won(part.data.operations.refundAmount)}` : undefined,
              },
            ]}
          />
        </div>
      )}
    </Section>
  );
}

function Broadcasts() {
  const [part, retry] = usePart<Broadcast[]>("/api/seller/broadcast/history", (d) => (d as { items: Broadcast[] }).items.slice(0, BROADCAST_ROWS));
  if (part.kind === "hidden") return null;
  return (
    <Section title="방송" actions={<Link className="btn btn-out" href="/seller/broadcasts">방송 이력</Link>}>
      {part.kind === "loading" && <LoadingRows rows={2} />}
      {part.kind === "error" && <ErrorState title="방송을 불러오지 못했습니다" onRetry={retry} />}
      {part.kind === "ok" &&
        (part.data.length === 0 ? (
          <div className="home-empty">아직 진행한 방송이 없습니다</div>
        ) : (
          <table className="tbl" data-testid="home-broadcasts">
            <thead>
              <tr>
                <th>방송</th>
                <th>시작</th>
                <th>방송 시간</th>
                <th>주문</th>
                <th>매출</th>
              </tr>
            </thead>
            <tbody>
              {part.data.map((b) => (
                <tr key={b.id}>
                  <td className="col-text">
                    <Link href={`/seller/broadcasts/${b.id}`}>{b.title || "제목 없음"}</Link>
                    {b.status === "live" && <span className="home-live">방송 중</span>}
                  </td>
                  <td>{kstDate(b.startedAt)}</td>
                  <td>{kstDuration(b.startedAt, b.endedAt)}</td>
                  <td>{count(b.summary.paidOrders)}</td>
                  <td>{won(b.summary.sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </Section>
  );
}

export function HomeDashboard() {
  const { me } = useSeller();
  return (
    <>
      <Topbar crumb="홈 › 홈" />
      <main className="main">
        <div className="home">
          <PageHead title="홈" />
          <p className="t-l2 c-alt" style={{ margin: 0 }}>
            {me.shop.name}의 오늘 상황입니다
          </p>
          <TodayTasks />
          <Performance />
          <Broadcasts />
        </div>
      </main>
    </>
  );
}
