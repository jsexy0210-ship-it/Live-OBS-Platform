"use client";

import "../stats/stats.css";
import "./home.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm } from "../../admin-ui";
import { useSeller } from "../SellerShell";
import { ErrorState, LoadingRows } from "../States";
import { api } from "../api";
import { kstDuration, type BroadcastSummary } from "../broadcast/history";
import { formatDateTime } from "../../../lib/client/format";
import { won } from "../format";
import { kstToday } from "../stats/StatsFrame";
import { Kpis, count } from "../stats/parts";

// 단일 SA-002 홈의 쇼핑몰 운영 구역. 처리할 일 → 성과 → 방송 기록 순서를 보존한다.
// API: GET /api/seller/today-tasks(항목별 권한이 없으면 서버가 뺀다), GET /api/seller/stats/overview?from=오늘&to=오늘(통계 권한),
//      GET /api/seller/broadcast/history(방송 권한). 권한이 없거나 막힌 구역은 가짜 값 없이 구역째 감춘다.
// STORE_OPERATIONS 역할에서만 단일 홈이 이 구역을 표시한다. 별도 홈·제목·진입 경로는 두지 않는다.
type Onboarding = { completed: boolean; dismissed: boolean; doneCount: number; total: number };
type Task = { key: string; count: number; href: string };
type Tasks = { total: number; items: Task[] };
type Overview = {
  summary: { current: { revenue: number; orders: number; averageOrderValue: number | null }; previous: { revenue: number; orders: number; averageOrderValue: number | null } };
  operations: { cancelled: number; refunded: number; refundAmount: number };
};
type Broadcast = { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null; summary: BroadcastSummary };

const TASK_LABEL: Record<string, string> = {
  depositPending: "입금 확인 필요",
  shipPending: "배송 준비 필요",
  returnRequested: "반품 요청 답변 필요",
  inquiryWaiting: "문의 답변 필요",
  stockOut: "품절 상품",
  stockLow: "재고 부족 상품",
};
const BROADCAST_ROWS = 3;

type Part<T> = { kind: "loading" } | { kind: "hidden" } | { kind: "error" } | { kind: "ok"; data: T };

// pick은 모듈 안의 고정 함수만 넘긴다(렌더마다 바뀌는 함수를 넘기지 않음). 값은 ref에 두어 의존 배열에는 path만 쓴다.
function usePart<T>(path: string, pick: (raw: never) => T): [Part<T>, () => void] {
  const [state, setState] = useState<Part<T>>({ kind: "loading" });
  const [n, setN] = useState(0);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    void api<never>(path).then((r) => {
      if (!live) return;
      if (r.ok) setState({ kind: "ok", data: pickRef.current(r.data) });
      else setState({ kind: r.status === 403 || r.status === 402 ? "hidden" : "error" });
    });
    return () => {
      live = false;
    };
  }, [path, n]);
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

// 시작하기 띠: 온보딩이 끝나지 않았고 닫지 않았을 때만 보인다(GET /api/seller/onboarding). 닫기는 서버 dismiss 상태를 따르고,
// 닫을 수 있는 건 대표자·쇼핑몰 설정 권한뿐이라 권한이 없으면 닫기 버튼을 두지 않는다. 다시 열기는 시작하기 화면에서 한다.
function OnboardingStrip() {
  const { can } = useSeller();
  const [part] = usePart<Onboarding>("/api/seller/onboarding", (d) => d as Onboarding);
  const [closed, setClosed] = useState(false);
  const { confirm } = useConfirm();
  if (part.kind !== "ok" || part.data.completed || part.data.dismissed || closed) return null;
  const close = async () => {
    const ok = await confirm({
      title: "시작하기 안내를 숨기시겠습니까?",
      body: "홈에서 시작하기 안내가 사라집니다. 시작하기 화면에서 다시 열 수 있습니다.",
      confirmLabel: "숨기기",
      run: async () => {
        const r = await api("/api/seller/onboarding", { method: "POST", body: { action: "dismiss" } });
        return r.ok ? undefined : "안내를 숨기지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오";
      },
    });
    if (ok) setClosed(true);
  };
  return (
    <div className="home-onboarding" data-testid="home-onboarding">
      <span className="t">시작하기</span>
      <span className="n">
        {part.data.doneCount}/{part.data.total} 완료
      </span>
      <Link className="btn btn-out" href="/seller/onboarding">
        이어서 하기
      </Link>
      {can("SHOP_SETTINGS") && (
        <button type="button" className="btn btn-out" onClick={() => void close()}>
          시작하기 안내 숨기기
        </button>
      )}
    </div>
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
          <div className="home-empty">오늘 처리할 일이 없습니다</div>
        ) : (
          <>
            <div className="home-tasks" data-testid="home-tasks">
              {part.data.items.map((t) => (
                <Link key={t.key} href={t.href} className={`home-task${t.count === 0 ? " zero" : ""}`} data-testid={`home-task-${t.key}`}>
                  <span className="l">{TASK_LABEL[t.key] ?? "확인할 일"}</span>
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
              { label: "결제된 매출", now: part.data.summary.current.revenue, prev: part.data.summary.previous.revenue, fmt: won },
              { label: "주문", now: part.data.summary.current.orders, prev: part.data.summary.previous.orders, fmt: count },
              { label: "주문 1건당 평균 금액", now: part.data.summary.current.averageOrderValue, prev: part.data.summary.previous.averageOrderValue, fmt: won },
              {
                label: "취소·환불 건수",
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
    <Section title="방송" actions={<Link className="btn btn-out" href="/seller/broadcasts">방송 기록</Link>}>
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
                  <td>{formatDateTime(b.startedAt)}</td>
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

export function StoreHomeSections() {
  return (
        <div className="home">
          <OnboardingStrip />
          <TodayTasks />
          <Performance />
          <Broadcasts />
        </div>
  );
}
