"use client";

import "../stats/stats.css";
import "./home.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../../admin-ui";
import { Topbar, useSeller } from "../SellerShell";
import { ErrorState, LoadingRows } from "../States";
import { api } from "../api";
import { type BroadcastSummary } from "../broadcast/history";
import { formatDateTime } from "../../../lib/client/format";
import { won } from "../format";
import { kstToday } from "../stats/StatsFrame";
import { Kpis, count } from "../stats/parts";

// SA-002 파트너스 홈(쇼핑몰 통합 요금제). 오늘 처리할 일 → 성과(오늘) → 방송 순서(IA 개편, 대표님 지시 2026-10-05).
// API: GET /api/seller/today-tasks(항목별 권한이 없으면 서버가 뺀다), GET /api/seller/stats/overview?from=오늘&to=오늘(통계 권한),
//      GET /api/seller/broadcast/history(방송 권한). 권한이 없거나 막힌 구역은 가짜 값 없이 구역째 감춘다.
// 오버레이 전용 홈(SA-002-O)은 이 블록을 쓰지 않는다(화면-방송 담당). 공용 구역은 이 폴더의 컴포넌트로 가져다 쓴다.
type Onboarding = { completed: boolean; dismissed: boolean; doneCount: number; total: number };
type Task = { key: string; count: number; href: string; overTwoDays?: number; oldestAt?: string | null };
type Tasks = { at: string; total: number; items: Task[] };
type Overview = {
  summary: { current: { revenue: number; orders: number; averageOrderValue: number | null }; previous: { revenue: number; orders: number; averageOrderValue: number | null } };
  operations: { cancelled: number; refunded: number; refundAmount: number };
};
type Broadcast = { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null; summary: BroadcastSummary };
type Upcoming = { id: string; title: string; status: "upcoming"; scheduledStartAt: string | null };

const TASK_LABEL: Record<string, string> = {
  depositPending: "입금 확인 필요",
  shipPending: "배송 준비 필요",
  returnRequested: "반품 요청 답변 필요",
  inquiryWaiting: "문의 답변 필요",
  stockOut: "품절 상품",
  stockLow: "재고 부족 상품",
};
const BROADCAST_ROWS = 3;
const broadcastTime = (b: Broadcast) => b.status === "live" ? `${formatDateTime(b.startedAt).slice(-5)} ~` : `${formatDateTime(b.startedAt)} ~ ${b.endedAt ? formatDateTime(b.endedAt).slice(-5) : ""}`;

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

function Section({ title, sub, actions, children }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="home-sec">
      <div className="home-sec-h">
        <h2>
          {title}
        </h2>
        {sub && <span className="sub">{sub}</span>}
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
  const { can } = useSeller();
  const [part, retry] = usePart<Tasks>("/api/seller/today-tasks", (d) => d as Tasks);
  const stockOut = part.kind === "ok" ? part.data.items.find((item) => item.key === "stockOut") : undefined;
  if (part.kind === "hidden") return null;
  return (
    <Section title="오늘 처리할 일" sub={<><span className="home-copy-pc">숫자를 누르면 해당 조건이 걸린 목록으로 이동합니다</span><span className="home-copy-mobile">숫자를 누르면 그 목록으로</span>{part.kind === "ok" ? ` · ${formatDateTime(part.data.at)} 집계` : ""}</>}>
      {part.kind === "loading" && <LoadingRows rows={2} />}
      {part.kind === "error" && <ErrorState title="처리할 일을 불러오지 못했습니다" onRetry={retry} />}
      {part.kind === "ok" &&
        (part.data.total === 0 ? (
          <><div className="home-empty">지금 처리할 일이 없습니다. 새 주문이 들어오면 여기에 표시됩니다.</div>{can("BROADCAST_RUN") && <Link className="btn btn-out" href="/seller/broadcast">방송 대시보드</Link>}</>
        ) : (
          <>
            <div className="home-tasks" data-testid="home-tasks">
              {["depositPending", "shipPending", "inquiryWaiting", "stockLow", "returnRequested"].flatMap((key) => part.data.items.filter((t) => t.key === key)).map((t) => t.key === "stockLow" ? (
                <div key={t.key} className={`home-task home-task-stock${t.count === 0 ? " zero" : ""} hot`} data-testid={`home-task-${t.key}`}>
                  <Link href={t.href} className="l">{TASK_LABEL[t.key]}</Link>
                  <Link href={t.href} className="v" aria-label={`재고 부족 상품 ${t.count}개 보기`}>{t.count.toLocaleString("ko-KR")}개</Link>
                  {stockOut && stockOut.count > 0 ? <Link className="note home-task-stock-out" href={stockOut.href} aria-label={`품절 상품 ${stockOut.count}개 보기`}>품절 임박 · 품절 {stockOut.count.toLocaleString("ko-KR")}개</Link> : <span className="note">품절 임박 · 품절 0개</span>}
                </div>
              ) : (
                <Link key={t.key} href={t.href} className={`home-task${t.count === 0 ? " zero" : ""}${["depositPending", "shipPending"].includes(t.key) ? " hot" : ""}`} data-testid={`home-task-${t.key}`}>
                  <span className="l">{TASK_LABEL[t.key] ?? "확인할 일"}</span>
                  <span className="v">{t.count.toLocaleString("ko-KR")}건</span>
                  {t.key === "depositPending" && <span className="note">입금 전 · 2일 넘음 {t.overTwoDays ?? 0}건</span>}
                  {t.key === "shipPending" && <span className="note">송장 입력 전</span>}
                  {t.key === "inquiryWaiting" && t.oldestAt && <span className="note">오래된 문의 {Math.floor((new Date(part.data.at).getTime() - new Date(t.oldestAt).getTime()) / 86_400_000) > 0 ? `${Math.floor((new Date(part.data.at).getTime() - new Date(t.oldestAt).getTime()) / 86_400_000)}일 전` : "오늘"}</span>}
                </Link>
              ))}
            </div>
          </>
        ))}
    </Section>
  );
}

function Performance() {
  const today = kstToday();
  const [part, retry] = usePart<Overview>(`/api/seller/stats/overview?from=${today}&to=${today}&compare=elapsed`, (d) => d as Overview);
  if (part.kind === "hidden") return <Section title="오늘 성과" sub="직원 권한 없음"><div className="home-empty">매출 · 성과는 대표자와 통계 권한이 있는 직원에게만 표시됩니다. 처리할 일은 내 권한에 해당하는 항목만 보입니다.</div></Section>;
  return (
    <Section title="오늘 성과" sub="결제 완료 기준 · 어제 같은 시각 대비" actions={<Link className="btn btn-out" href="/seller/stats">분석 자세히</Link>}>
      {part.kind === "loading" && <LoadingRows rows={2} />}
      {part.kind === "error" && <ErrorState title="오늘 성과를 불러오지 못했습니다" onRetry={retry} />}
      {part.kind === "ok" && (
        <div className="home-performance" data-testid="home-performance">
          <Kpis compact caption="어제 같은 시각"
            items={[
              { label: "결제된 매출", now: part.data.summary.current.revenue, prev: part.data.summary.previous.revenue, fmt: won, note: `어제 같은 시각 ${won(part.data.summary.previous.revenue)}` },
              { label: "오늘 주문", now: part.data.summary.current.orders, prev: part.data.summary.previous.orders, fmt: count, note: "취소 · 환불 제외" },
              { label: "주문 1건당 평균 금액", labelDisplay: <>주문 1건당 평균<span className="home-copy-pc"> 금액</span></>, now: part.data.summary.current.averageOrderValue, prev: part.data.summary.previous.averageOrderValue, fmt: won, note: `어제 ${part.data.summary.previous.averageOrderValue === null ? "—" : won(part.data.summary.previous.averageOrderValue)}` },
              {
                label: "취소·환불 건수",
                now: null,
                prev: null,
                fmt: count,
                compare: false,
                text: `${count(part.data.operations.cancelled + part.data.operations.refunded)}`,
                note: `환불 ${count(part.data.operations.refunded)} · 취소 ${count(part.data.operations.cancelled)}`,
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
  const [youtube, retryYoutube] = usePart<Upcoming | null>("/api/seller/youtube", (d) => {
    const live = (d as { live: Upcoming | { status: string } | null }).live;
    return live?.status === "upcoming" ? live as Upcoming : null;
  });
  if (part.kind === "hidden") return null;
  const rows: (Broadcast | Upcoming)[] = part.kind === "ok" ? [...part.data.filter((b) => b.status === "live"), ...(youtube.kind === "ok" && youtube.data ? [youtube.data] : []), ...part.data.filter((b) => b.status === "ended")].slice(0, BROADCAST_ROWS) : [];
  const time = (b: Broadcast | Upcoming) => b.status === "upcoming" ? b.scheduledStartAt ? formatDateTime(b.scheduledStartAt) : "—" : broadcastTime(b);
  const href = (b: Broadcast | Upcoming) => b.status === "ended" ? `/seller/broadcasts/${b.id}` : "/seller/broadcast";
  return (
    <Section title="방송" sub="진행 · 예정 · 최근 종료" actions={<Link className="btn btn-out" href="/seller/broadcasts">방송 이력</Link>}>
      {part.kind === "loading" && <LoadingRows rows={2} />}
      {part.kind === "error" && <ErrorState title="방송을 불러오지 못했습니다" onRetry={retry} />}
      {youtube.kind === "error" && <ErrorState title="예정 방송을 불러오지 못했습니다" onRetry={retryYoutube} />}
      {part.kind === "ok" &&
        (rows.length === 0 && youtube.kind === "ok" ? (
          <div className="home-empty">진행 · 예정 방송이 없습니다. 방송 대시보드에서 첫 방송을 시작해 주십시오.</div>
        ) : (
          <table className="tbl tbl-card" data-testid="home-broadcasts">
            <thead>
              <tr>
                <th>방송</th>
                <th>상태</th>
                <th>시각</th>
                <th>주문</th>
                <th>매출</th>
                <th>바로 가기</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td className="col-text" data-card="title">
                    <Link href={href(b)}>{b.title || "제목 없음"}</Link>
                    <small className="home-broadcast-time">{time(b)}</small>
                  </td>
                  <td data-card="status"><span className={`home-status ${b.status}`}>{b.status === "live" ? "진행 중" : b.status === "upcoming" ? "예정" : "종료"}</span></td>
                  <td data-card="hide">{time(b)}</td>
                  <td>{b.status === "upcoming" ? "—" : count(b.summary.paidOrders)}</td>
                  <td>{b.status === "upcoming" ? "—" : won(b.summary.sales)}</td>
                  <td data-card="actions"><Link className={`btn btn-sm${b.status === "live" ? "" : " btn-out"}`} href={href(b)}>{b.status === "live" ? "방송 보기" : b.status === "upcoming" ? "준비하기" : "결과 보기"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </Section>
  );
}

export function HomeDashboard() {
  const { me, can } = useSeller();
  return (
    <>
      <Topbar crumb="홈 › 홈" />
      <main className="main">
        <div className="home">
          <PageHead title="홈" description={`${me.shop.name}의 오늘 상황입니다`} actions={<><a className="btn btn-out" href={`/shop/${encodeURIComponent(me.shop.slug)}`} target="_blank" rel="noreferrer">쇼핑몰 보기</a>{can("BROADCAST_RUN") && <Link className="btn" href="/seller/broadcast">방송 대시보드</Link>}</>} />
          <OnboardingStrip />
          <TodayTasks />
          <Performance />
          <Broadcasts />
        </div>
      </main>
    </>
  );
}
