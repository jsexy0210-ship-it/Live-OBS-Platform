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
  const { can, me } = useSeller();
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
  const initialPaging = useRef(true);
  const pagingScope = useRef("");
  const pendingRestore = useRef<{ scope: string; page: number; cursors: (string | undefined)[]; ids: string[]; next: string | null; scrollY: number } | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async (status: Status) => {
    const id = ++reqId.current; paging.current = false;
    let scope = "";
    try { if (me.sellerId && me.userId) scope = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([me.sellerId, me.userId, status])))), n => n.toString(16).padStart(2, "0")).join(""); } catch {}
    if (id !== reqId.current) return;
    pagingScope.current = scope;
    let restore = pendingRestore.current?.scope === scope ? pendingRestore.current : undefined;
    if (initialPaging.current && scope) {
      try {
        const raw = sessionStorage.getItem("onq:refund-requests:return"); sessionStorage.removeItem("onq:refund-requests:return");
        const saved = JSON.parse(raw ?? "null");
        if (saved?.scope === scope && Number.isInteger(saved.page) && saved.page >= 1 && Array.isArray(saved.cursors) && saved.cursors.length === saved.page && saved.cursors[0] === null && saved.cursors.slice(1).every((c: unknown) => typeof c === "string" && c.length > 0) && Array.isArray(saved.ids) && saved.ids.length <= 10 && saved.ids.every((value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) && new Set(saved.ids).size === saved.ids.length && (saved.next === null || typeof saved.next === "string" && saved.next.length > 0) && Number.isFinite(saved.scrollY) && saved.scrollY >= 0) restore = { scope, page: saved.page, cursors: saved.cursors.map((c: string | null) => c ?? undefined), ids: saved.ids, next: saved.next, scrollY: saved.scrollY };
      } catch {}
    }
    pendingRestore.current = restore ?? null;
    setPage(restore?.page ?? 1); setCursors(restore?.cursors ?? [undefined]);
    setState({ kind: "loading" });
    const cursor = restore?.cursors[restore.page - 1];
    const r = await api<List>(`/api/seller/refund-requests?status=${status}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (id !== reqId.current) return;
    if (!r.ok) return setState({ kind: "error", status: r.status });
    initialPaging.current = false; pendingRestore.current = null;
    const visible = restore ? restore.ids.flatMap((rowId) => r.data.requests.filter((row) => row.id === rowId)) : r.data.requests;
    if (restore) { try { sessionStorage.setItem("scroll:seller-refund-requests", String(restore.scrollY)); } catch {} }
    if (restore && visible.length === 0 && restore.page > 1) {
      const previous = restore.page - 1, before = restore.cursors[previous - 1];
      const result = await api<List>(`/api/seller/refund-requests?status=${status}${before ? `&cursor=${encodeURIComponent(before)}` : ""}`);
      if (id !== reqId.current) return;
      if (result.ok) {
        setPage(previous); setCursors(restore.cursors.slice(0, previous));
        return setState({ kind: "ok", rows: result.data.requests, next: result.data.nextCursor, counts: result.data.counts });
      }
      setToast({ text: "불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    }
    setState({ kind: "ok", rows: visible, next: restore ? restore.next : r.data.nextCursor, counts: r.data.counts });
  }, [me.sellerId, me.userId]);
  useEffect(() => {
    setState({ kind: "loading" });
    void load(tab);
    return () => { reqId.current++; };
  }, [tab, load]);

  useScrollRestore("seller-refund-requests", state.kind === "ok");
  const rememberPage = () => {
    if (state.kind !== "ok" || !pagingScope.current) return;
    try { sessionStorage.setItem("onq:refund-requests:return", JSON.stringify({ scope: pagingScope.current, page, cursors: cursors.slice(0, page), ids: state.rows.map((row) => row.id), next: state.next, scrollY: window.scrollY })); } catch {}
  };

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
                            <Link className="btn btn-sm" href={`/seller/orders/refund-requests/${r.id}?${new URLSearchParams({ returnTo })}`} onClick={rememberPage}>
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
