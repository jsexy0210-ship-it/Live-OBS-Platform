"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { PAYMENT_KIND } from "../../../_components/payments";
import { day, dayTime, won } from "../../../_components/partners";
import { REFUND_STATUS, refundReason, type RefundCounts, type RefundListItem, type RefundSummary } from "../../../_components/refunds";

// MA-026 환불 요청 목록(GET /api/admin/subscription-refunds, 모든 마스터 역할, 조회만). 탭의 숫자는 서버의 상태별 전체 수를 묶은 값.
// 대기 = 처리 대기·처리 중·실패, 완료 = 환불 완료. 승인·거절은 상세(MA-027)에서 한다. 요청 최신 순 50건씩 이어서 불러온다.
type Page = { items: RefundListItem[]; counts: RefundCounts; summary: RefundSummary; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: RefundListItem[]; counts: RefundCounts; summary: RefundSummary; next: string | null };
type Tab = "pending" | "done" | "rejected" | "";
const TABS: { key: Tab; label: string }[] = [
  { key: "pending", label: "대기" },
  { key: "done", label: "완료" },
  { key: "rejected", label: "거절" },
  { key: "", label: "전체" },
];
// 요청 뒤 지난 시간(끝난 요청은 처리한 시각까지가 아니라 표시하지 않는다)
const since = (iso: string, now: number) => {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  return m < 60 ? `${m}분` : m < 1440 ? `${Math.floor(m / 60)}시간` : `${Math.floor(m / 1440)}일${m % 1440 >= 60 ? ` ${Math.floor((m % 1440) / 60)}시간` : ""}`;
};

export default function RefundsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const qs = (status: string, cursor?: string) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (cursor) p.set("cursor", cursor);
    return p.toString();
  };
  const load = useCallback(async (status: string) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/subscription-refunds?${qs(status)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items, counts: r.data.counts, summary: r.data.summary, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(tab), [tab, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/subscription-refunds?${qs(tab, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ ...state, items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const counts = state.kind === "ok" ? state.counts : null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const tabCount = (t: Tab) => (!counts ? null : t === "pending" ? counts.REQUESTED + counts.PROCESSING + counts.FAILED : t === "done" ? counts.REFUNDED : t === "rejected" ? counts.REJECTED : total);
  const items = state.kind === "ok" ? state.items : [];
  const sum = state.kind === "ok" ? state.summary : null;
  const now = Date.now();

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 환불 요청" />
      <main className="main">
        <PageHead title="환불 요청" />
        <div className="col" style={{ gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            {[
              ["검토 대기", counts ? `${counts.REQUESTED}건` : "-", "refund-requested"],
              ["이번 달 환불 완료", sum ? `${sum.monthRefunded.count}건 · ${won(sum.monthRefunded.amount)}` : "-", "refund-month"],
              ["거절", counts ? `${counts.REJECTED}건` : "-", "refund-rejected"],
              ["평균 처리", sum ? (sum.avgProcessDays === null ? "-" : `${sum.avgProcessDays.toFixed(1)}일`) : "-", "refund-avg"],
            ].map(([label, value, id]) => (
              <div key={id} className="card pad col" style={{ gap: 4 }}>
                <span className="t-l2 c-alt">{label}</span>
                <span className="t-h2" data-testid={id}>
                  {value}
                </span>
              </div>
            ))}
          </div>
          <div className="seg" role="radiogroup" aria-label="상태" style={{ alignSelf: "flex-start" }}>
            {TABS.map((t) => (
              <button key={t.key || "all"} type="button" role="radio" aria-checked={tab === t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}>
                {t.label}
                {tabCount(t.key) !== null && ` ${tabCount(t.key)}`}
              </button>
            ))}
          </div>
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="환불 요청을 불러오지 못했습니다." onRetry={() => void load(tab)} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{tab === "pending" ? "대기 중인 환불 요청이 없습니다." : "환불 요청이 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} loaded={state.next !== null} />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>요청</th>
                          <th>파트너스</th>
                          <th>청구</th>
                          <th>요청 금액</th>
                          <th>사유</th>
                          <th>경과</th>
                          <th>담당</th>
                          <th>상태</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r) => (
                          <tr key={r.id} data-testid="refund-row">
                            <td>{dayTime(r.createdAt)}</td>
                            <td>
                              <b>{r.shopName}</b>
                            </td>
                            <td>
                              {PAYMENT_KIND[r.payment.kind]} · {day(r.payment.periodStart)} ~ {day(r.payment.periodEnd)}
                            </td>
                            <td>{won(r.amount)}</td>
                            <td className="col-text">{refundReason(r.reason)}</td>
                            <td>{r.status === "REQUESTED" || r.status === "PROCESSING" || r.status === "FAILED" ? since(r.createdAt, now) : "—"}</td>
                            <td>{r.assignee ?? "—"}</td>
                            <td>
                              <span className={`bdg ${REFUND_STATUS[r.status].cls}`}>{REFUND_STATUS[r.status].label}</span>
                            </td>
                            <td>
                              <Link className={`btn btn-sm ${r.status === "REQUESTED" || r.status === "FAILED" || r.status === "PROCESSING" ? "" : "btn-out"}`} href={`/admin/billing/refunds/${r.id}`}>
                                처리
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: "12px 16px" }}>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                        {more ? "불러오는 중" : "더 보기"}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
