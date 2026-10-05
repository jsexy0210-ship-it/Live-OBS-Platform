"use client";

import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ListHead, Modal, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { won } from "../../../../../../components/seller/format";
import type { RefundFault, RefundPreview } from "../../../../../../components/seller/orders";
import { kstText } from "../../banners/_shared/ui";
import "./refund-requests.css";

// SA-023 구매자 환불 요청 처리(파트너스 관리자, 주문 › 환불 요청). 발송 전 주문에서 구매자가 보낸 환불 요청을 보고, 승인(요청한 상품으로 환불)하거나 사유를 적어 거절한다.
// 조회·처리는 대표자 · 주문 배송(ORDER_SHIPPING) 권한 직원. API: /api/seller/refund-requests(목록 · 상세 · reject · approve).
// 승인은 상세가 준 queueVersion과 사유 주체별 미리보기 금액(refundPreview.byFault[fault].refundAmount)으로만 보낸다.
type Status = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
type Sel = { orderItemId: string; quantity: number }[];
type Row = {
  id: string;
  orderId: string;
  orderNo: number;
  nickname: string;
  totalAmount: number;
  status: Status;
  reason: string;
  reasonLabel: string;
  reasonText: string;
  items: Sel | null;
  rejectReason: string | null;
  decidedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
};
type Detail = Row & {
  order: { status: string; totalAmount: number };
  refundPreview: RefundPreview | null;
  previewError: string | null;
  queueVersion: number | null;
};
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
const FAULTS: { key: RefundFault; label: string; desc: string }[] = [
  { key: "BUYER", label: "구매자 사정", desc: "변심 · 잘못 주문" },
  { key: "SELLER", label: "파트너스 사정", desc: "품절 · 오류" },
];
const PREVIEW_ERROR: Record<string, string> = {
  invalid_refund_items: "요청한 뒤 주문 화면에서 이미 환불한 상품이 있어 승인할 수 없습니다. 거절해 주십시오.",
  queued_item_partial: "개봉 대기 중인 상품이 있어 일부만 환불할 수 없습니다. 거절하거나 주문 화면에서 처리해 주십시오.",
  opened_items_unshipped: "개봉한 상품을 보내지 않아 환불할 수 없습니다. 거절하거나 주문 화면에서 처리해 주십시오.",
};

export default function RefundRequestsPage() {
  const { can } = useSeller();
  const canEdit = can("ORDER_SHIPPING");
  // 탭은 주소(?status=)가 기준이다. 주문 상세에 갔다 Back으로 돌아와도 그대로 복원된다(UX 감사 9.3). 틀린 값은 처리 대기로 본다
  const [u, setU] = useUrlState({ status: "REQUESTED" });
  const tab: Status = TABS.some((t) => t.key === u.status) ? (u.status as Status) : "REQUESTED";
  const setTab = (t: Status) => setU({ status: t });
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async (status: Status) => {
    const r = await api<List>(`/api/seller/refund-requests?status=${status}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", rows: r.data.requests, next: r.data.nextCursor, counts: r.data.counts });
  }, []);
  useEffect(() => {
    setState({ kind: "loading" });
    void load(tab);
  }, [tab, load]);

  useScrollRestore("seller-refund-requests", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const r = await api<List>(`/api/seller/refund-requests?status=${tab}&cursor=${state.next}`);
    setMore(false);
    if (!r.ok) return setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    const seen = new Set(state.rows.map((x) => x.id));
    setState({ ...state, rows: [...state.rows, ...r.data.requests.filter((x) => !seen.has(x.id))], next: r.data.nextCursor, counts: r.data.counts });
  };

  const counts = state.kind === "ok" ? state.counts : {};
  const rows = state.kind === "ok" ? state.rows : [];

  return (
    <>
      <Topbar crumb="판매 › 환불 요청" />
      <main className="main">
        <PageHead
          title="환불 요청"
          actions={
            <Link className="btn btn-out" href="/seller/orders">
              전체 주문
            </Link>
          }
        />
        <span className="t-c1 c-alt">발송 전 주문에서 구매자가 보낸 환불 요청입니다. 승인하면 요청한 상품으로 바로 환불되고, 거절하면 사유가 구매자에게 보입니다.</span>
        <div className="card" style={{ overflow: "visible" }}>
          <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
            {TABS.map((t) => (
              <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
                {(counts[t.key] ?? 0) > 0 && <span className="cnt">{counts[t.key]}</span>}
              </button>
            ))}
          </div>
          {state.kind === "ok" && <ListHead total={counts[tab] ?? rows.length} />}
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문 · 배송" /> : state.status === 402 ? <Locked /> : <ErrorState title="환불 요청을 불러오지 못했습니다" onRetry={() => void load(tab)} />)}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">{tab === "REQUESTED" ? "처리할 환불 요청이 없습니다" : "해당하는 환불 요청이 없습니다"}</span>
              <span className="s">결제 완료 뒤 발송 전의 주문에서 구매자가 요청할 수 있습니다.</span>
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <div className="au-lt-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>요청 시각</th>
                    <th>구매자</th>
                    <th>주문</th>
                    <th>주문 금액</th>
                    <th>사유</th>
                    <th>상태</th>
                    <th style={{ width: 110 }} aria-label="작업" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} data-testid="refund-request-row">
                      <td className="num">{kstText(r.createdAt)}</td>
                      <td className="fw6">{r.nickname}</td>
                      <td className="num">{r.orderNo}</td>
                      <td className="num">{won(r.totalAmount)}</td>
                      <td className="col-text ell">
                        {r.reasonLabel}
                        {r.items ? " · 일부 상품" : ""}
                      </td>
                      <td>
                        <span className={`bdg ${BADGE[r.status].cls}`}>{BADGE[r.status].label}</span>
                      </td>
                      <td>
                        <button className="btn btn-sm" type="button" onClick={() => setOpenId(r.id)}>
                          {r.status === "REQUESTED" && canEdit ? "처리" : "보기"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ok" && state.next && (
            <div className="row" style={{ padding: "12px 20px", justifyContent: "center" }}>
              <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
                더 불러오기
              </button>
            </div>
          )}
        </div>
        {state.kind === "ok" && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>환불 요청 처리는 대표자나 주문 · 배송 권한이 있는 직원만 할 수 있습니다.</span>
          </div>
        )}
      </main>
      {openId && (
        <RequestDetail
          id={openId}
          canEdit={canEdit}
          onClose={() => setOpenId(null)}
          onDone={(text) => {
            const doneId = openId;
            setOpenId(null);
            setToast({ text });
            // 처리한 행만 뺀다(불러온 쪽수·스크롤 유지). 탭별 건수만 새로 읽는다
            setState((s) => (s.kind === "ok" ? { ...s, rows: s.rows.filter((r) => r.id !== doneId) } : s));
            void api<List>(`/api/seller/refund-requests?status=${tab}`).then((r) => {
              if (r.ok) setState((s) => (s.kind === "ok" ? { ...s, counts: r.data.counts } : s));
            });
          }}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function RequestDetail({ id, canEdit, onClose, onDone }: { id: string; canEdit: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<RefundFault | null>(null);
  const [agree, setAgree] = useState(false);
  const [openedOk, setOpenedOk] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/seller/refund-requests/${id}`);
    if (!r.ok) return setLoadFailed(true);
    setLoadFailed(false);
    setD(r.data);
    return r.data;
  }, [id]);
  useEffect(() => {
    void load().then((v) => v && setFault((cur) => cur ?? (v.reason === "CHANGE_OF_MIND" ? "BUYER" : null)));
  }, [load]);

  const pending = d?.status === "REQUESTED";
  const preview = d?.refundPreview ?? null;
  // 이번에 환불하는 상품: 요청이 상품을 고르지 않았으면 남은 상품 전부
  const picked = preview?.items?.filter((i) => (d?.items ? d.items.some((s) => s.orderItemId === i.orderItemId) : i.refundableQuantity > 0)) ?? [];
  const qty = (itemId: string, fallback: number) => d?.items?.find((s) => s.orderItemId === itemId)?.quantity ?? fallback;
  const hasOpened = picked.some((i) => i.opened);
  const quote = preview && fault ? preview.byFault[fault] : null;

  const approve = async () => {
    if (!d || !quote || d.queueVersion === null) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/refund-requests/${id}/approve`, {
      method: "POST",
      body: { expectedVersion: d.queueVersion, expectedRefundAmount: quote.refundAmount, fault, confirmOpened: hasOpened && openedOk },
    });
    setBusy(false);
    if (r.ok) return onDone(`${won(quote.refundAmount)} 환불을 승인했습니다`);
    // 그사이 주문이 바뀌었으면 상세를 다시 읽어 새 금액을 다시 확인받는다
    if (r.error === "conflict" || r.error === "refund_amount_changed") {
      setAgree(false);
      void load();
      return setError("그사이 주문 정보가 바뀌었습니다. 환불 금액을 다시 확인해 주십시오.");
    }
    if (r.error === "invalid_transition") void load();
    setError(r.message ?? "환불하지 못했습니다. 결제는 그대로입니다. 잠시 후 다시 시도해 주십시오.");
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/refund-requests/${id}/reject`, { method: "POST", body: { reason: rejectReason.trim() } });
    setBusy(false);
    if (r.ok) return onDone("환불 요청을 거절했습니다");
    if (r.error === "invalid_transition") void load();
    setError(r.message ?? "거절하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
  };

  const canApprove = !!quote && !quote.blocked && fault !== null && agree && (!hasOpened || openedOk) && d?.queueVersion !== null;

  return (
    <Modal labelId="rr-title" className="modal-lg rr-modal" busy={busy} onClose={onClose}>
      <div className="modal-h">
        <h2 className="modal-t" id="rr-title">
          {d ? `환불 요청 · 주문 ${d.orderNo}` : "환불 요청"}
        </h2>
      </div>
      <div className="col" style={{ gap: 16 }}>
        {loadFailed && !d && (
          <div className="msg msg-neg" role="alert">
            <span>환불 요청을 불러오지 못했습니다. 다시 시도해 주십시오.</span>
            <button className="btn btn-sm" type="button" onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        )}
        {!d && !loadFailed && <LoadingRows rows={3} />}
        {d && (
          <div className="col" style={{ gap: 16 }}>
            <div className="rr-kv t-l2">
              <span className="c-alt">상태</span>
              <span>
                <span className={`bdg ${BADGE[d.status].cls}`}>{BADGE[d.status].label}</span>
              </span>
              <span className="c-alt">구매자</span>
              <span>{d.nickname}</span>
              <span className="c-alt">주문</span>
              <span>
                <Link href={`/seller/orders/${d.orderId}`} className="num">
                  {d.orderNo}
                </Link>{" "}
                · <span className="num">{won(d.order.totalAmount)}</span>
              </span>
              <span className="c-alt">요청 시각</span>
              <span className="num">{kstText(d.createdAt)}</span>
              <span className="c-alt">사유</span>
              <span>{d.reasonLabel}</span>
              {d.reasonText && (
                <>
                  <span className="c-alt">상세 사유</span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{d.reasonText}</span>
                </>
              )}
              <span className="c-alt">환불 상품</span>
              <span className="col" style={{ gap: 2 }}>
                {picked.length > 0 ? (
                  picked.map((i) => (
                    <span key={i.orderItemId}>
                      {i.productName} · {i.optionName} · {qty(i.orderItemId, i.refundableQuantity)}개{i.opened ? " (개봉)" : ""}
                    </span>
                  ))
                ) : (
                  <span>{d.items ? `${d.items.length}종 일부 상품` : "남은 상품 전부"}</span>
                )}
              </span>
              {d.rejectReason && (
                <>
                  <span className="c-alt">거절 사유</span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{d.rejectReason}</span>
                </>
              )}
              {d.decidedAt && (
                <>
                  <span className="c-alt">처리 시각</span>
                  <span className="num">{kstText(d.decidedAt)}</span>
                </>
              )}
              {d.cancelledAt && (
                <>
                  <span className="c-alt">철회 시각</span>
                  <span className="num">{kstText(d.cancelledAt)}</span>
                </>
              )}
            </div>

            {pending && d.previewError && (
              <div className="msg msg-neg" role="alert">
                <span>{PREVIEW_ERROR[d.previewError] ?? "환불 금액을 계산하지 못했습니다. 거절하거나 주문 화면에서 처리해 주십시오."}</span>
              </div>
            )}

            {pending && canEdit && preview && !rejecting && (
              <>
                <div className="fld">
                  <span className="lbl" id="rr-fault-label">
                    사유 주체
                  </span>
                  <div className="refund-faults" role="radiogroup" aria-labelledby="rr-fault-label">
                    {FAULTS.map((f) => (
                      <label key={f.key} className={`refund-opt${fault === f.key ? " on" : ""}`}>
                        <input
                          className="rdo"
                          type="radio"
                          name="rr-fault"
                          checked={fault === f.key}
                          disabled={busy}
                          onChange={() => {
                            setFault(f.key);
                            setAgree(false);
                          }}
                        />
                        <span className="col">
                          <span className="t-l1 fw6">{f.label}</span>
                          <span className="t-c1 c-alt">{f.desc}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <span className="help">구매자 사정만 결제 후 취소 횟수에 포함됩니다 · 선택하지 않으면 환불할 수 없습니다</span>
                </div>
                {quote && (
                  <div className="col" style={{ gap: 4 }}>
                    <span className="t-l1 fw6 num" data-testid="rr-cash">
                      현금 환불 {won(quote.refundAmount)}
                    </span>
                    <span className="t-c1 c-alt num" data-testid="rr-reward">
                      적립금 반환 {won(quote.rewardReturn)}
                    </span>
                    {quote.returnFeeDeducted > 0 && <span className="t-c1 c-alt num">반품 배송비 {won(quote.returnFeeDeducted)} 차감</span>}
                    {quote.blocked && <span className="err">이 사유 주체로는 환불할 수 없는 주문입니다</span>}
                  </div>
                )}
                {hasOpened && (
                  <label className="row t-l2" style={{ gap: 8 }}>
                    <input className="cbx" type="checkbox" checked={openedOk} onChange={(e) => setOpenedOk(e.target.checked)} />
                    개봉한 상품이 있는 주문임을 확인했습니다
                  </label>
                )}
                {quote && !quote.blocked && (
                  <label className="row t-l2" style={{ gap: 8 }}>
                    <input className="cbx" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                    위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.
                  </label>
                )}
              </>
            )}

            {pending && canEdit && rejecting && (
              <div className="fld">
                <label htmlFor="rr-reject" className="req">
                  거절 사유
                </label>
                <textarea id="rr-reject" className="inp" style={{ height: 88, padding: "10px 12px" }} maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                <span className="help">구매자에게 보입니다 · {rejectReason.length}/200자</span>
              </div>
            )}

            {error && (
              <div className="msg msg-neg" role="alert">
                <span>{error}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
          취소
        </button>
        {pending && canEdit && !rejecting && (
          <>
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setRejecting(true)}>
              거절
            </button>
            <button className="btn" type="button" disabled={busy || !canApprove} onClick={() => void approve()}>
              {busy ? "처리 중" : "승인하고 환불"}
            </button>
          </>
        )}
        {pending && canEdit && rejecting && (
          <>
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setRejecting(false)}>
              뒤로
            </button>
            <button className="btn" type="button" disabled={busy || !rejectReason.trim()} onClick={() => void reject()}>
              {busy ? "처리 중" : "거절 확정"}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
