"use client";

import Link from "next/link";
import "../../../../../styles/seller-broadcast.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, ListTable, PageHead, CursorPagination, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { useScrollRestore } from "../../../../../lib/client/navigation";
import { effectiveRange, listDefaults, type PeriodFilter } from "../../../../../lib/client/filterDefaults";
import { useListFilters } from "../../../../(admin)/admin/_components/useListFilters";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { won } from "../../../../../components/seller/format";
import { kstDuration, type BroadcastSummary } from "../../../../../components/seller/broadcast/history";
import { LAYOUT_LABEL } from "../../../../../components/seller/broadcast/hit";
import { formatDateTime } from "../../../../../lib/client/format";
import { DateRangePicker } from "../../../../../components/admin-ui/DatePicker";

// SA-054 방송 기록(방송별). 방송 시작일(KST) 기간으로 검색하고, 한 줄을 누르면 방송 상세(SA-055)로 간다.
// API: GET /api/seller/broadcast/history?from=&to=&cursor=(시작 최신순 10개)
// 월 요약은 서버의 이번 달(KST) 집계를 그대로 표시한다. 내보내기는 적용된 기간·레이아웃을 사용하며 쪽 커서는 보내지 않는다.

type Item = { id: string; title: string | null; status: "live" | "ended"; startedAt: string; endedAt: string | null; layout: "9x16" | "16x9" | null; summary: Omit<BroadcastSummary, "sales"> & { sales: number | null } };
type MonthSummary = { broadcasts: number; seconds: number; orders: number; avgSales: number | null; avgOpenSeconds: number | null };
type Page = { items: Item[]; nextCursor: string | null; monthSummary?: MonthSummary };
type Load = { kind: "loading" } | { kind: "error"; status: number; error: string } | { kind: "ok"; items: Item[]; next: string | null; month?: MonthSummary };
type Filter = PeriodFilter & { layout?: string };

const query = (f: Filter, cursor?: string | null) => {
  const q = new URLSearchParams();
  const { from, to } = effectiveRange(f);
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (f.layout) q.set("layout", f.layout);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return `/api/seller/broadcast/history${s ? `?${s}` : ""}`;
};

export default function BroadcastHistoryPage() {
  const { can, me } = useSeller();
  const allowed = can("BROADCAST_RUN");
  const [state, setState] = useState<Load>({ kind: "loading" });
  // 조회 조건은 주소(?from=&to=)가 기준이다: 상세 → ← 에서 그대로 돌아온다(docs/IA.md Back 규칙 3항)
  // 기본은 최근 1개월(목록 공통 규칙, lib/client/filterDefaults.ts). 기간을 비우고 검색하면 전체 기간. 서버는 아직 정렬·쪽 크기를 받지 않아 from·to만 보낸다
  const defaults = listDefaults({ layout: "" });
  const { applied, draft, setDraft, apply, reset } = useListFilters(defaults);
  // 업무 큐 링크(?period=all)로 들어오면 기간 칸은 비워 보인다(전체 기간)
  useEffect(() => {
    if (applied.period === "all") setDraft((d) => ({ ...d, from: "", to: "" }));
  }, [applied, setDraft]);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const paging = useRef(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  // 조건이 바뀌면 마지막으로 보낸 조건의 응답만 반영한다
  const seq = useRef(0);

  const load = useCallback(async (f: Filter) => {
    const n = ++seq.current;
    paging.current = true;
    setPage(1); setCursors([null]);
    setState({ kind: "loading" });
    const r = await api<Page>(query(f));
    if (n !== seq.current) return;
    paging.current = false;
    setState(r.ok ? { kind: "ok", items: r.data.items, next: r.data.nextCursor, month: r.data.monthSummary } : { kind: "error", status: r.status, error: r.error });
  }, []);
  useEffect(() => {
    if (allowed) void load(applied);
  }, [allowed, applied, load]);

  const go = async (target: number, cursor: string | null) => {
    if (state.kind !== "ok" || paging.current) return;
    const n = ++seq.current;
    paging.current = true;
    let actualPage = target;
    let actualCursor = cursor;
    let r = await api<Page>(query(applied, actualCursor));
    while (n === seq.current && r.ok && r.data.items.length === 0 && actualPage > 1) {
      actualPage -= 1; actualCursor = cursors[actualPage - 1];
      r = await api<Page>(query(applied, actualCursor));
    }
    if (n !== seq.current) return;
    paging.current = false;
    if (!r.ok) return setToast({ text: failMessage(r, "admin"), neg: true });
    setState({ kind: "ok", items: r.data.items, next: r.data.nextCursor, month: r.data.monthSummary });
    setPage(actualPage);
    setCursors(c => { const next = c.slice(0, actualPage); next[actualPage - 1] = actualCursor; return c[actualPage] === r.data.nextCursor ? c : next; });
  };

  useScrollRestore("seller-broadcasts", state.kind === "ok");

  const search = () => {
    if (draft.from && draft.to && draft.from > draft.to) return setToast({ text: "시작일을 끝일보다 앞 날짜로 바꿔 주십시오", neg: true });
    apply({ ...applied, from: draft.from, to: draft.to, layout: draft.layout, period: "" });
  };
  const items = state.kind === "ok" ? state.items : [];
  const month = state.kind === "ok" ? state.month : undefined;
  const exportHref = query(applied).replace("/history", "/history/export");

  return (
    <>
      <Topbar crumb="방송 › 방송 기록" />
      <main className="main">
        <PageHead title="방송 기록" actions={allowed && !me.readOnly && state.kind === "ok" ? <a className="btn btn-out" href={exportHref} download title="목록 검색 조건 · 최대 5,000건">내보내기</a> : undefined} />
        {!allowed ? (
          <div className="card">
            <NoPermission need="방송 진행" />
          </div>
        ) : (
          <>
            {month && (
              <section aria-labelledby="bh-month-title" data-testid="bh-month-summary">
                <h2 className="t-hl1 bc-sum-t" id="bh-month-title">이번 달 방송 요약 (KST) <span className="t-l2 c-alt fw5">목록 검색 조건과 별개</span></h2>
                <div className="bc-sum-g">
                  <div className="stat"><span className="t-l2 c-alt">이번 달 방송</span><span className="v">{month.broadcasts.toLocaleString("ko-KR")}회</span><span className="t-l2 c-alt">{Math.floor(month.seconds / 3600).toLocaleString("ko-KR")}시간 {Math.floor(month.seconds % 3600 / 60)}분</span></div>
                  <div className="stat"><span className="t-l2 c-alt">이번 달 주문</span><span className="v">{month.orders.toLocaleString("ko-KR")}건</span></div>
                  <div className="stat"><span className="t-l2 c-alt">방송당 평균 매출</span><span className="v">{month.avgSales == null ? "—" : won(month.avgSales)}</span></div>
                  <div className="stat"><span className="t-l2 c-alt">평균 오픈 시간</span><span className="v">{month.avgOpenSeconds == null ? "—" : `${month.avgOpenSeconds.toLocaleString("ko-KR")}초`}</span></div>
                </div>
              </section>
            )}
            <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
              <SearchRow
                label="기간"
                label2="레이아웃"
                children2={
                  <select className="inp" aria-label="레이아웃" value={draft.layout} onChange={(e) => setDraft({ ...draft, layout: e.target.value })}>
                    <option value="">전체</option>
                    <option value="9x16">{LAYOUT_LABEL["9x16"]}</option>
                    <option value="16x9">{LAYOUT_LABEL["16x9"]}</option>
                  </select>
                }
              >
                <DateRangePicker fromLabel="시작일" toLabel="종료일" from={draft.from} to={draft.to} onChange={(r) => setDraft({ ...draft, from: r.from, to: r.to })} quick />
              </SearchRow>
            </SearchBox>

            <section className="au-list-section">
              {state.kind === "loading" && <div className="card"><LoadingRows rows={4} /></div>}
              {state.kind === "error" &&
                (state.status === 402 ? (
                  <div className="card"><Locked /></div>
                ) : state.status === 403 && state.error === "plan_feature_required" ? (
                  <div className="card"><div className="st" style={{ boxShadow: "none" }}>
                    <span className="t">지금 이용 중인 이용권에는 이 기능이 없습니다. 구독 화면에서 이용권을 바꾸면 사용할 수 있습니다</span>
                  </div></div>
                ) : state.status === 403 ? (
                  <NoPermission need="방송 진행" />
                ) : (
                  <div className="card"><ErrorState title="방송 기록을 불러오지 못했습니다" onRetry={() => void load(applied)} /></div>
                ))}
              {state.kind === "ok" && (
                <>
                  <ListHead total={items.length} loaded />
                  {items.length === 0 ? (
                    <div className="card"><div className="st" style={{ boxShadow: "none" }} data-testid="bh-empty">
                      <span className="t">{applied.period !== "all" && !applied.layout && applied.from === defaults.from && applied.to === defaults.to ? "최근 1개월에는 방송 기록이 없습니다. 기간을 바꿔 다시 찾아 주십시오" : applied.layout || (applied.period !== "all" && (applied.from || applied.to)) ? "조건에 맞는 방송이 없습니다" : "아직 방송 기록이 없습니다"}</span>
                      <Link className="btn btn-sm" href="/seller/broadcast">
                        방송 대시보드
                      </Link>
                    </div></div>
                  ) : (
                    <ListTable aria-label="방송 기록 표">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>제목</th>
                            <th>일시</th>
                            <th>시간</th>
                            <th>주문</th>
                            <th>완료 / 뺀 주문</th>
                            <th>HIT 카드</th>
                            <th>매출</th>
                            <th>레이아웃</th>
                            <th>상태</th>
                          </tr>
                        </thead>
                        <tbody data-testid="bh-list">
                          {items.map((b) => (
                            <tr key={b.id}>
                              <td className="col-text">
                                <Link href={`/seller/broadcasts/${b.id}`} className="fw6" data-testid="bh-link">
                                  {b.title || "제목 없는 방송"}
                                </Link>
                              </td>
                              <td className="num">{formatDateTime(b.startedAt)}{b.status === "live" ? "~" : ""}</td>
                              <td className="num">{kstDuration(b.startedAt, b.endedAt)}</td>
                              <td className="num">{b.summary.orders.toLocaleString("ko-KR")}</td>
                              <td className="num">
                                {b.summary.completed} / {b.summary.cancelled}
                              </td>
                              <td className="num">{b.summary.hits}</td>
                              <td className="num">{b.summary.sales == null ? "—" : won(b.summary.sales)}</td>
                              <td data-testid="bh-layout">{b.layout ? LAYOUT_LABEL[b.layout] : "—"}</td>
                              <td>{b.status === "live" ? <span className="bdg b-live">진행 중</span> : b.summary.orders === 0 ? <span className="bdg b-wait">종료 · 주문 없음</span> : <span className="bdg b-done">종료</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ListTable>
                  )}
                  {(cursors.length > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={n => void go(n, cursors[n - 1])} onNext={() => { if (state.next) void go(page + 1, state.next); }} />}
                  <span className="t-c1 c-alt">방송 시작부터 종료까지를 한 건으로 기록합니다 · 진행 중인 방송은 맨 위에 보입니다</span>
                </>
              )}
            </section>
          </>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
