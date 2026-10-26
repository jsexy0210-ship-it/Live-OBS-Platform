"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTable, CursorPagination, ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { OVERLAY_STATE, type SellerActivity } from "../../../_components/ops";
import { day, dayTime, won } from "../../../_components/partners";

// MA-042 주문·방송 화면 접속. 전체 이용 중·정지 파트너스 요약과 10곳 단위 목록을 조회한다.
type PeriodKey = "today" | "7d" | "30d";
type Page = { at: string; observedAt: string; todayStart: string; period: { key: PeriodKey; from: string; to: string; timezone: string }; summary: { created: number; paid: number; paidAmount: number }; items: SellerActivity[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; at: string; observedAt: string; period: Page["period"]; summary: Page["summary"]; items: SellerActivity[]; next: string | null };

export default function SellerActivityPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [offOnly, setOffOnly] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    paging.current = false;
    setPage(1);
    setCursors([undefined]);
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/ops/seller-activity?period=${period}&liveOnly=${liveOnly ? "1" : ""}&offOnly=${offOnly ? "1" : ""}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", at: r.data.at, observedAt: r.data.observedAt, period: r.data.period, summary: r.data.summary, items: r.data.items, next: r.data.nextCursor } : { kind: "error" });
  }, [period, liveOnly, offOnly]);
  useEffect(() => void load(), [load]);

  const changePage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next ?? undefined;
    if (target > 1 && !cursor) return;
    paging.current = true; setMore(true);
    const id = ++reqId.current;
    const current = state;
    const p = new URLSearchParams({ period, asOf: current.at, liveOnly: liveOnly ? "1" : "", offOnly: offOnly ? "1" : "" });
    if (cursor) p.set("cursor", cursor);
    const r = await adminApi<Page>(`/api/admin/ops/seller-activity?${p}`);
    if (id !== reqId.current) return;
    paging.current = false; setMore(false);
    if (r.ok) {
      if (target > cursors.length) setCursors(c => [...c, cursor]);
      setPage(target);
      setState({ ...current, items: r.data.items, next: r.data.nextCursor });
    } else setToast("목록을 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const all = state.kind === "ok" ? state.items : [];
  const items = all;
  const summary = state.kind === "ok" ? state.summary : { created: 0, paid: 0, paidAmount: 0 };
  const periodLabel = period === "today" ? "오늘" : period === "7d" ? "7일" : "30일";
  const rangeLabel = state.kind !== "ok" ? "조회 중" : period === "today" ? day(state.period.from) : `${day(state.period.from)} ~ ${day(state.period.to)}`;

  return (
    <>
      <AdminTopbar crumb="운영 › 주문 · 방송 화면 접속" />
      <main className="main">
        <PageHead title="주문 · 방송 화면 접속" description="기간별 주문 현황과 방송 화면 접속 상태를 파트너스별로 확인합니다." />
        <div className="col" style={{ gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          {[
            [`${periodLabel} 주문`, `${summary.created.toLocaleString("ko-KR")}건`, "act-created"],
            [`${periodLabel} 결제`, `${summary.paid.toLocaleString("ko-KR")}건`, "act-paid"],
            [`${periodLabel} 결제 금액`, won(summary.paidAmount), "act-amount"],
            ["현재 쪽 연결 중", `${all.filter((s) => s.overlay.connected).length}곳`, "act-connected"],
            ].map(([label, value, id]) => (
              <div key={id} className="card pad col" style={{ gap: 4 }}>
                <span className="t-l2 c-alt">{label}</span>
                <span className="t-h2" data-testid={id}>
                  {value}
                </span>
              </div>
            ))}
          </div>
          <div className="row" role="radiogroup" aria-label="주문 집계 기간">
            {([["today", "오늘"], ["7d", "7일"], ["30d", "30일"]] as const).map(([key, label]) => <button key={key} className={`btn btn-sm ${period === key ? "btn-primary" : "btn-out"}`} role="radio" aria-checked={period === key} type="button" onClick={() => setPeriod(key)}>{label}</button>)}
          </div>
          <p className="t-c1 c-alt" style={{ margin: 0 }}>
            {periodLabel} 기간 {rangeLabel} (KST). 주문·결제 요약은 전체 이용 중·정지 파트너스 합계이며, 방송 화면 연결 수와 표의 행은 현재 쪽 목록 기준입니다. 7일·30일은 오늘을 포함합니다. 주문은 생성일, 결제 건수와 금액은 결제일 기준이며 현재 환불을 반영합니다. 외부 주문은 포함하지 않습니다. 집계 시각 {state.kind === "ok" ? dayTime(state.observedAt) : "—"}; 파트너스와 방송 상태는 현재값입니다.
          </p>

          <div className="card pad row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="chk">
              <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
              방송 중만
            </label>
            <label className="chk">
              <input type="checkbox" checked={offOnly} onChange={(e) => setOffOnly(e.target.checked)} />
              방송 화면 연결 안 됨
            </label>
          </div>

          <section className="au-list-section">
            {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
            {state.kind === "error" && <div className="card"><ErrorState title="주문·방송 화면 접속 현황을 불러오지 못했습니다." onRetry={() => void load()} /></div>}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{liveOnly || offOnly ? "조건에 맞는 파트너스가 없습니다." : "이용 중인 파트너스가 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} unit="곳" loaded />
                  <ListTable>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>파트너스</th>
                          <th>방송</th>
                          <th>주문</th>
                          <th>결제</th>
                          <th>결제 금액</th>
                          <th>방송 화면 접속</th>
                          <th>마지막 접속</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((s) => {
                          const o = OVERLAY_STATE(s.overlay);
                          return (
                            <tr key={s.sellerId} data-testid="activity-row">
                              <td>
                                <b>{s.shopName}</b> <span className="c-alt">· 쇼핑몰 주소 {s.slug}</span>
                                {s.status === "SUSPENDED" && <span className="bdg b-fail"> 이용 정지</span>}
                              </td>
                              <td>{s.live ? <span className="bdg b-done">방송 중</span> : "-"}</td>
                              <td>{s.ordersPeriod.created}</td>
                              <td>{s.ordersPeriod.paid}</td>
                              <td>{won(s.ordersPeriod.paidAmount)}</td>
                              <td>
                                <span className={`bdg ${o.cls}`}>{o.label}</span>
                              </td>
                              <td>{dayTime(s.overlay.lastSeenAt)}</td>
                              <td>
                                <Link className="btn btn-sm btn-out" href={`/admin/partners/${s.sellerId}`}>
                                  상세
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </ListTable>
                  <div aria-busy={more}>{(cursors.length > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={(n) => void changePage(n)} onNext={() => void changePage(page + 1)} />}</div>
                </>
              ))}
          </section>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
