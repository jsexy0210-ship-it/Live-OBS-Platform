"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PageHead } from "../../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../../components/seller/SellerShell";
import { LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { api } from "../../../../../../../components/seller/api";
import { won } from "../../../../../../../components/seller/format";
import type { RefundFault, RefundRequestDetail } from "../../../../../../../components/seller/orders";
import { sanitizeNext, useSmartBack } from "../../../../../../../lib/client/navigation";
import { kstText } from "../../../banners/_shared/ui";
import "../refund-requests.css";

type Status = RefundRequestDetail["status"];
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


function RefundRequestContent() {
  const query = useSearchParams();
  const safeReturnTo = sanitizeNext(query.get("returnTo"), ["/seller/orders/refund-requests"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/orders/refund-requests" ? safeReturnTo : "/seller/orders/refund-requests";
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSeller();
  const smartBack = useSmartBack(listHref);
  const router = useRouter();
  const back = useCallback(() => safeReturnTo?.split("?")[0] === "/seller/orders/refund-requests" ? router.replace(listHref) : smartBack(), [safeReturnTo, listHref, router, smartBack]);
  const [toast, setToast] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  return <><Topbar crumb="판매 › 주문 › 취소 · 환불 요청" /><main className="main">
    <PageHead title="환불 요청 상세" back={listHref} />
    <RequestDetail key={id + ":" + reload} id={id} canEdit={can("ORDER_SHIPPING") && !me.readOnly} onClose={back} onDone={(text) => { setToast(text); setReload((n) => n + 1); }} />
  </main>{toast && <Toast text={toast} onDone={() => setToast(null)} />}</>;
}

function RequestDetail({ id, canEdit, onClose, onDone }: { id: string; canEdit: boolean; onClose: () => void; onDone: (text: string) => void }) {
  const [d, setD] = useState<RefundRequestDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<RefundFault | null>(null);
  const [agree, setAgree] = useState(false);
  const [openedOk, setOpenedOk] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    const r = await api<RefundRequestDetail>(`/api/seller/refund-requests/${id}`);
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
    if (r.ok) return onDone(`환불을 승인했습니다 · ${won(quote.refundAmount)} 환불을 요청했습니다`);
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
    <section className="card pad col" aria-labelledby="rr-title">
      <div className="modal-h">
        <h2 className="modal-t" id="rr-title">
          환불 요청 처리 {d && <span className="t-l2 c-alt fw4">주문 {d.orderNoLabel} · {d.nickname ?? "탈퇴 회원"}</span>}
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
            <div className="rr-sum">
              <div>
                <div className="k">주문</div>
                <div className="v num">
                  <Link href={`/seller/orders/${d.orderId}`}>{d.orderNoLabel}</Link>
                </div>
              </div>
              <div>
                <div className="k">요청 시각</div>
                <div className="v num">{kstText(d.createdAt)}</div>
              </div>
              <div>
                <div className="k">사유</div>
                <div className="v">{d.reasonLabel}</div>
              </div>
              <div>
                <div className="k">상태</div>
                <div className="v">
                  <span className={`bdg ${BADGE[d.status].cls}`}>{BADGE[d.status].label}</span>
                </div>
              </div>
            </div>

            {pending && d.previewError && (
              <div className="msg msg-neg" role="alert">
                <span>{PREVIEW_ERROR[d.previewError] ?? "환불 금액을 계산하지 못했습니다. 거절하거나 주문 화면에서 처리해 주십시오."}</span>
              </div>
            )}

            <table className="au-ft">
              <tbody>
                {d.reasonText && (
                  <tr>
                    <th>상세 사유</th>
                    <td style={{ whiteSpace: "pre-wrap" }}>{d.reasonText}</td>
                  </tr>
                )}
                <tr>
                  <th>환불 상품</th>
                  <td>
                    {picked.length > 0 ? (
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th className="col-text" style={{ textAlign: "left" }}>
                              환불 상품
                            </th>
                            <th style={{ width: 80 }}>수량</th>
                            <th style={{ width: 110, textAlign: "right" }}>금액</th>
                          </tr>
                        </thead>
                        <tbody>
                          {picked.map((i) => {
                            const q = qty(i.orderItemId, i.refundableQuantity);
                            return (
                              <tr key={i.orderItemId}>
                                <td className="col-text">
                                  {i.productName} · {i.optionName}
                                  {i.opened ? " (개봉)" : ""}
                                </td>
                                <td className="num">{q}</td>
                                <td className="num" style={{ textAlign: "right" }}>
                                  {q === i.refundableQuantity ? won(i.refundableAmount) : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <span>{d.items ? `${d.items.length}종 일부 상품` : "남은 상품 전부"}</span>
                    )}
                  </td>
                </tr>
                {pending && canEdit && preview && !rejecting && (
                  <>
                    <tr>
                      <th>
                        <span id="rr-fault-label">사유 주체</span> <span className="sc-rq">*</span>
                      </th>
                      <td>
                        <div className="row" style={{ gap: 16, flexWrap: "wrap" }} role="radiogroup" aria-labelledby="rr-fault-label">
                          {FAULTS.map((f) => (
                            <label key={f.key} className="row" style={{ gap: 6 }}>
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
                              <span>
                                {f.label} <span className="t-c1 c-alt">{f.desc}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                        <span className="help">구매자 사정만 결제 후 취소 횟수에 포함됩니다 · 선택하지 않으면 환불할 수 없습니다</span>
                      </td>
                    </tr>
                    {quote && (
                      <tr>
                        <th>환불 미리보기</th>
                        <td>
                          <span className="fw6 num" data-testid="rr-cash">
                            현금 환불 {won(quote.refundAmount)}
                          </span>
                          <span className="t-c1 c-alt num" data-testid="rr-reward">
                            {" "}
                            · 적립금 반환 {won(quote.rewardReturn)}
                          </span>
                          {quote.returnFeeDeducted > 0 && <span className="t-c1 c-alt num"> · 반품 배송비 {won(quote.returnFeeDeducted)} 차감</span>}
                          {quote.blocked && <span className="err">이 사유 주체로는 환불할 수 없는 주문입니다 · 다른 사유 주체를 고르거나 거절해 주십시오</span>}
                        </td>
                      </tr>
                    )}
                    {(hasOpened || (quote && !quote.blocked)) && (
                      <tr>
                        <th>확인</th>
                        <td>
                          {hasOpened && (
                            <label className="row t-l2" style={{ gap: 8 }}>
                              <input className="cbx" type="checkbox" checked={openedOk} onChange={(e) => setOpenedOk(e.target.checked)} />
                              개봉한 상품이 있는 주문임을 확인했습니다
                            </label>
                          )}
                          {quote && !quote.blocked && (
                            <label className="row t-l2" style={{ gap: 8 }}>
                              <input className="cbx" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                              요청한 상품으로 환불하는 것을 확인했습니다
                            </label>
                          )}
                          <span className="help">환불한 뒤에는 되돌릴 수 없습니다</span>
                        </td>
                      </tr>
                    )}
                  </>
                )}
                {pending && canEdit && rejecting && (
                  <tr>
                    <th>
                      <label htmlFor="rr-reject">거절 사유</label> <span className="sc-rq">*</span>
                    </th>
                    <td>
                      <textarea id="rr-reject" className="inp" style={{ height: 88, padding: "10px 12px" }} maxLength={200} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                      <span className="help">구매자에게 보입니다 · {rejectReason.length}/200자</span>
                    </td>
                  </tr>
                )}
                {d.rejectReason && (
                  <tr>
                    <th>거절 사유</th>
                    <td style={{ whiteSpace: "pre-wrap" }}>{d.rejectReason}</td>
                  </tr>
                )}
                {d.decidedAt && (
                  <tr>
                    <th>처리 시각</th>
                    <td className="num">{kstText(d.decidedAt)}</td>
                  </tr>
                )}
                {d.cancelledAt && (
                  <tr>
                    <th>철회 시각</th>
                    <td className="num">{kstText(d.cancelledAt)}</td>
                  </tr>
                )}
              </tbody>
            </table>

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
          목록으로
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
              돌아가기
            </button>
            <button className="btn" type="button" disabled={busy || !rejectReason.trim()} onClick={() => void reject()}>
              {busy ? "처리 중" : "거절 처리"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

export default function RefundRequestPage() { return <Suspense><RefundRequestContent /></Suspense>; }
