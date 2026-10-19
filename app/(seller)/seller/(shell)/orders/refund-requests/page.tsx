"use client";

import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTable, CursorPagination, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { won } from "../../../../../../components/seller/format";
import type { RefundRequestRow } from "../../../../../../components/seller/orders";
import { kstText } from "../../banners/_shared/ui";
import "./refund-requests.css";

// SA-023 구매자 환불 요청 처리(파트너스 관리자, 주문 › 환불 요청). 발송 전 주문에서 구매자가 보낸 환불 요청을 보고, 승인(요청한 상품으로 환불)하거나 사유를 적어 거절한다.
// 조회·처리는 대표자 · 주문 배송(ORDER_SHIPPING) 권한 직원. API: /api/seller/refund-requests(목록 · 상세 · reject · approve).
// 승인은 상세가 준 queueVersion과 사유 주체별 미리보기 금액(refundPreview.byFault[fault].refundAmount)으로만 보낸다.
type Status = RefundRequestRow["status"];
type Row = RefundRequestRow;
type List = { requests: Row[]; nextCursor: string | null; counts: Partial<Record<Status, number>> };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; next: string | null; counts: List["counts"] };

const TABS: { key: Status; label: string }[] = [
  { key: "REQUESTED", label: "처리 대기" },
  { key: "APPROVED", label: "승인" },
  { key: "REJECTED", label: "거절" },
  { key: "CANCELLED", label: "철회" },
];
const BADGE: Record<Status, { label: string; cls: string }> = {
  REQUESTED: { label: "처리 대기", cls: "b-pending" },
  APPROVED: { label: "승인", cls: "b-done" },
  REJECTED: { label: "거절", cls: "b-gray nodot" },
  CANCELLED: { label: "철회", cls: "b-gray nodot" },
};
export default function RefundRequestsPage() {
  const listQuery = useSearchParams().toString();
  const returnTo = `/seller/orders/refund-requests${listQuery ? `?${listQuery}` : ""}`;
  const { can } = useSeller();
  const canEdit = can("ORDER_SHIPPING");
  // 탭은 주소(?status=)가 기준이다. 주문 상세에 갔다 Back으로 돌아와도 그대로 복원된다(UX 감사 9.3). 틀린 값은 처리 대기로 본다
  const [u, setU] = useUrlState({ status: "REQUESTED" });
  const tab: Status = TABS.some((t) => t.key === u.status) ? (u.status as Status) : "REQUESTED";
  const setTab = (t: Status) => setU({ status: t });
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const reqId = useRef(0);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async (status: Status) => {
    const id = ++reqId.current; setPage(1); setCursors([undefined]); paging.current = false;
    setState({ kind: "loading" });
    const r = await api<List>(`/api/seller/refund-requests?status=${status}`);
    if (id !== reqId.current) return;
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", rows: r.data.requests, next: r.data.nextCursor, counts: r.data.counts });
  }, []);
  useEffect(() => {
    setState({ kind: "loading" });
    void load(tab);
  }, [tab, load]);

  useScrollRestore("seller-refund-requests", state.kind === "ok");

  const turnPage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true; const id = ++reqId.current;
    const r = await api<List>("/api/seller/refund-requests?status=" + tab + "&" + (cursor ? "cursor=" + encodeURIComponent(cursor) : ""));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast({ text: "불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    setState({ kind: "ok", rows: r.data.requests, next: r.data.nextCursor, counts: r.data.counts });
    setPage(target); setCursors(c => {
      const visited = target > c.length ? [...c, cursor ?? undefined] : c;
      return visited[target] && visited[target] !== r.data.nextCursor ? visited.slice(0, target) : visited;
    });
  };

  const counts = state.kind === "ok" ? state.counts : {};
  const rows = state.kind === "ok" ? state.rows : [];

  return (
    <>
      <Topbar crumb="주문 › 취소 · 교환 · 반품" />
      <main className="main">
        <PageHead
          title="취소 · 환불 요청"
          actions={
            <Link className="btn btn-out" href="/seller/orders">
              전체 주문
            </Link>
          }
        />
        <span className="t-c1 c-alt">발송 전 주문에서 구매자가 보낸 환불 요청입니다. 승인하면 요청한 상품으로 바로 환불되고, 거절하면 사유가 구매자에게 보입니다. 발송 뒤 요청은 「교환 · 반품」 탭에서 처리합니다.</span>
        <section className="au-list-section" style={{ overflow: "visible" }}>
          <div className="row" role="tablist" aria-label="처리 상태" style={{ gap: 8, flexWrap: "wrap", padding: "12px 20px" }}>
            {TABS.map((t) => (
              <button key={t.key} className={`chip${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
                {state.kind === "ok" && <span className="num">{counts[t.key] ?? 0}</span>}
              </button>
            ))}
          </div>
          {state.kind === "ok" && (
            <div className="row" style={{ gap: 8, padding: "12px 20px", boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }}>
              <b className="t-hl2" data-testid="refund-summary">
                {TABS.find((t) => t.key === tab)?.label} {counts[tab] ?? rows.length}건
              </b>
              <span className="t-c1 c-alt">요청 시각 최신순</span>
            </div>
          )}
          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문 · 배송" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="환불 요청을 불러오지 못했습니다" onRetry={() => void load(tab)} /></div>)}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="card"><div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">{tab === "REQUESTED" ? "처리할 환불 요청이 없습니다" : "해당하는 환불 요청이 없습니다"}</span>
              <span className="s">결제 완료 뒤 발송 전의 주문에서 구매자가 요청할 수 있습니다</span>
            </div></div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <ListTable>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="col-text" style={{ textAlign: "left", width: 190 }}>
                      주문
                    </th>
                    <th className="col-text" style={{ textAlign: "left", width: 170 }}>
                      요청 시각
                    </th>
                    <th className="col-text" style={{ textAlign: "left", width: 120 }}>
                      구매자
                    </th>
                    <th style={{ textAlign: "right", width: 110 }}>금액</th>
                    <th className="col-text" style={{ textAlign: "left" }}>
                      사유
                    </th>
                    <th style={{ width: 90 }}>상태</th>
                    <th style={{ width: 120 }}>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const waited = r.status === "REQUESTED" ? Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86_400_000) : 0;
                    return (
                      <tr key={r.id} data-testid="refund-request-row">
                        <td className="col-text">
                          <Link href={`/seller/orders/${r.orderId}`} className="num fw6">
                            {r.orderNoLabel}
                          </Link>
                        </td>
                        <td className="col-text num">
                          {kstText(r.createdAt)}
                          {waited >= 1 && <div className="t-c1 c-neg">{waited}일째 기다리는 중</div>}
                        </td>
                        <td className="col-text fw6">{r.nickname ?? "탈퇴 회원"}</td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {won(r.totalAmount)}
                        </td>
                        <td className="col-text ell">
                          {r.reasonLabel}
                          {r.items ? " · 일부 상품" : ""}
                        </td>
                        <td>
                          <span className={`bdg ${BADGE[r.status].cls}`}>{BADGE[r.status].label}</span>
                        </td>
                        <td>
                          <div className="acts2">
                            <Link className="btn btn-sm" href={`/seller/orders/refund-requests/${r.id}?${new URLSearchParams({ returnTo })}`}>
                              {r.status === "REQUESTED" && canEdit ? "처리" : "보기"}
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ListTable>
          )}
          {state.kind === "ok" && (page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={n => void turnPage(n)} onNext={() => void turnPage(page + 1)} />}
        </section>
        {state.kind === "ok" && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>보기만 할 수 있습니다. 바꾸려면 대표자에게 「주문·배송」 허용을 요청해 주십시오.</span>
          </div>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
