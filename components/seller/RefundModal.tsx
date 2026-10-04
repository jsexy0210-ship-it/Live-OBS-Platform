"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { api, failMessage } from "./api";
import { won } from "./format";
import { longTime, type OrderDetail, type RefundFault as Fault, type RefundPreview } from "./orders";

// SA-023 취소 · 환불 처리(모달). 주문 단위 환불만 된다(API에 부분 환불 없음).
// 사유 주체(구매자 사정 / 판매자 사정)는 꼭 골라야 하고, 고르지 않으면 환불 버튼이 꺼져 있다.
// 환불 금액은 서버 미리보기(refundPreview, 환불과 같은 계산)를 사유 주체별로 보여 준다. 구매자 사정이면 개봉한 상품·배송비를 빼고,
// 돌려줄 금액이 0원이면 환불 버튼 대신 안내만 보인다.
// 환불 API는 주문대기 버전(expectedVersion)을 받는다. 주문 상세 응답의 queueVersion을 쓰고(환불과 같은 권한으로 읽힘),
// 그사이 주문대기가 바뀌어 conflict가 오면 상세를 다시 읽는다. 환불 금액이 그대로면 새 버전으로 한 번만 다시 보내고,
// 바뀌었으면 보내지 않고 새 금액을 다시 확인받는다. 확인받은 금액(expectedRefundAmount)도 함께 보내,
// 서버 계산과 다르면(refund_amount_changed, 상태 그대로) 상세를 다시 읽어 새 금액을 다시 확인받는다.
const FAULTS: { key: Fault; label: string; desc: string }[] = [
  { key: "BUYER", label: "구매자 사정", desc: "변심 · 잘못 주문" },
  { key: "SELLER", label: "파트너스 사정", desc: "품절 · 오류" },
];
const REASONS = ["품절 · 재고 없음", "결제 오류 · 중복 결제", "기타"];

type Fail = { status: number; error: string; message?: string };

export default function RefundModal({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: (refundAmount: number) => void }) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [preview, setPreview] = useState<RefundPreview | null>(order.refundPreview ?? null);
  const [queueVersion, setQueueVersion] = useState(order.queueVersion);
  const [reason, setReason] = useState("");
  const [agree, setAgree] = useState(false);
  // 서버가 「개봉한 상품이 있어요」라고 하면 확인을 받은 뒤 confirmOpened로 다시 보낸다
  const [needOpened, setNeedOpened] = useState(!!order.refundPreview?.openedItems.length);
  const [openedOk, setOpenedOk] = useState(false);
  const [busy, setBusy] = useState(false);
  // retry: 원인을 모르는 실패(서버 오류·연결 끊김)는 「다시 시도」로 같은 내용을 다시 보낸다
  const [error, setError] = useState<{ title?: string; text: string; retry?: boolean } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // 고른 사유 주체의 환불액. 고르기 전에는 두 사유 주체의 금액이 같을 때만 보인다. 미리보기가 없으면(예전 응답) 금액을 단정하지 않는다
  const quote = preview && fault ? preview.byFault[fault] : null;
  const same = preview && preview.byFault.BUYER.refundAmount === preview.byFault.SELLER.refundAmount ? preview.byFault.SELLER.refundAmount : null;
  const amount = quote ? quote.refundAmount : fault === null ? same : null;
  const blocked = quote?.blocked === true;
  const nothing = quote !== null && !blocked && quote.refundAmount === 0;
  // 구매자 사정이면 빼는 항목(개봉한 상품, 발송했으면 처음 배송비·반품 배송비). 금액은 서버 계산(quote)이 기준이다
  const deductions =
    fault === "BUYER" && preview && !blocked
      ? [
          ...preview.openedItems.map((o) => ({ label: `개봉한 상품 · ${order.items.find((i) => i.id === o.orderItemId)?.productNameSnapshot ?? ""}`, amount: o.amount })),
          ...(preview.shipped && order.shippingFee > 0 ? [{ label: "처음 배송비", amount: order.shippingFee }] : []),
          ...(quote && quote.returnFeeDeducted > 0 ? [{ label: "반품 배송비", amount: quote.returnFeeDeducted }] : []),
        ]
      : [];
  const canSend = !blocked && !nothing;
  const ready = fault !== null && reason !== "" && agree && canSend && (!needOpened || openedOk) && !busy;
  const first = order.items[0];
  const summary = first ? `${first.productNameSnapshot}${order.items.length > 1 ? ` 외 ${order.items.length - 1}건` : ` ×${first.quantity}`}` : "";

  const chooseFault = (f: Fault) => {
    // 금액이 바뀌므로 「위 금액으로 환불해요」를 다시 받는다
    setFault(f);
    setAgree(false);
  };

  type Sent = { ok: true; refundAmount: number } | { ok: false; fail: Fail } | { ok: false; changed: RefundPreview | null; version: number };
  const send = async (): Promise<Sent> => {
    let version = queueVersion;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await api<{ refundAmount?: number }>(`/api/seller/orders/${order.id}/refund`, {
        method: "POST",
        body: { reason, expectedVersion: version, fault, confirmOpened: openedOk, expectedRefundAmount: quote?.refundAmount },
      });
      if (r.ok) return { ok: true, refundAmount: r.data.refundAmount ?? order.totalAmount };
      if (r.error === "refund_amount_changed") {
        const d = await api<{ queueVersion: number; refundPreview: RefundPreview | null }>(`/api/seller/orders/${order.id}`);
        if (!d.ok) return { ok: false, fail: r };
        return { ok: false, changed: d.data.refundPreview, version: d.data.queueVersion };
      }
      if (r.error !== "conflict" || attempt === 1) return { ok: false, fail: r };
      // 그사이 주문대기가 바뀌었으면(다른 화면·방송) 상세를 다시 읽어 새 버전으로 한 번만 다시 보낸다
      const d = await api<{ queueVersion: number; refundPreview: RefundPreview | null }>(`/api/seller/orders/${order.id}`);
      if (!d.ok) return { ok: false, fail: d };
      const next = d.data.refundPreview;
      const nextQuote = next && fault ? next.byFault[fault] : null;
      // 확인받은 금액과 다르면(그사이 개봉·발송) 보내지 않는다
      if (preview && (!nextQuote || nextQuote.refundAmount !== quote?.refundAmount || nextQuote.blocked || next!.openedItems.length !== preview.openedItems.length)) {
        return { ok: false, changed: next, version: d.data.queueVersion };
      }
      version = d.data.queueVersion;
    }
    return { ok: false, fail: { status: 409, error: "conflict" } };
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const r = await send();
    setBusy(false);
    if (r.ok) return onDone(r.refundAmount);
    if ("changed" in r) {
      setPreview(r.changed);
      setQueueVersion(r.version);
      if (r.changed?.openedItems.length) setNeedOpened(true);
      setAgree(false);
      setError({ text: r.changed ? "그사이 환불 금액이 변경되었습니다. 금액을 다시 확인해 주십시오" : "이미 환불했거나 지금은 환불할 수 없는 주문입니다" });
      return;
    }
    const f = r.fail;
    if (f.error === "opened_items_present") {
      setNeedOpened(true);
      setError({ text: failMessage(f) });
    } else if (f.status === 403) setError({ title: "이 기능은 권한이 필요합니다", text: "대표자에게 요청해 주십시오 · 필요한 권한: 주문·배송" });
    else if (f.error === "invalid_transition") setError({ text: "이미 환불했거나 지금은 환불할 수 없는 주문입니다" });
    else if (f.error === "conflict") setError({ text: "그사이 주문대기가 변경되었습니다. 다시 눌러 주십시오" });
    else if (f.message) setError({ text: f.message });
    else setError({ title: "환불하지 못했습니다.", text: "결제는 그대로입니다. 잠시 후 다시 시도해 주십시오.", retry: true });
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="refund-title">
      <div className="modal modal-lg refund-modal">
        <div className="modal-h">
          <h2 className="t-h2" id="refund-title">
            취소 · 환불 처리
          </h2>
          <span className="t-l2 c-alt">
            {order.buyer.broadcastNickname} · {longTime(order.createdAt)} 주문{summary && ` · ${summary}`}
          </span>
        </div>

        <section className="col" style={{ gap: 10 }}>
          <h3 className="t-hl2">환불 범위</h3>
          <div className="refund-opt on">
            <span className="col">
              <span className="t-l1 fw6">주문 전체 환불</span>
              <span className="t-c1 c-alt">
                {order.paymentMethod === "CARD" ? `${canSend && amount ? `${won(amount)} · ` : ""}카드 승인 취소` : canSend && amount ? won(amount) : "주문 전체 취소"}
              </span>
            </span>
          </div>
        </section>

        <section className="col" style={{ gap: 12 }}>
          <h3 className="t-hl2">사유 · 안내</h3>
          <div className="fld">
            <span className="lbl" id="fault-label">
              사유 주체
            </span>
            <div className="refund-faults" role="radiogroup" aria-labelledby="fault-label">
              {FAULTS.map((f) => (
                <label key={f.key} className={`refund-opt${fault === f.key ? " on" : ""}`}>
                  <input className="rdo" type="radio" name="fault" value={f.key} checked={fault === f.key} disabled={busy} onChange={() => chooseFault(f.key)} />
                  <span className="col">
                    <span className="t-l1 fw6">{f.label}</span>
                    <span className="t-c1 c-alt">{f.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            <span className="help">구매자 사정만 결제 후 취소 횟수에 포함됩니다 · 선택하지 않으면 환불할 수 없습니다</span>
            {fault === "BUYER" && <span className="t-c1 c-alt">이 취소는 구매자의 결제 후 취소 횟수에 포함됩니다</span>}
          </div>
          <div className="fld">
            <label htmlFor="refund-reason" className="req">
              처리 사유
            </label>
            <select id="refund-reason" className="inp" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}>
              <option value="" disabled>
                사유를 선택해 주십시오
              </option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="card pad col" style={{ gap: 10 }}>
          <span className="t-hl2">환불 요약</span>
          <dl className="kv">
            <dt>결제 금액</dt>
            <dd className="num">{won(order.totalAmount)}</dd>
            {deductions.map((d) => (
              <Fragment key={d.label}>
                <dt>{d.label}</dt>
                <dd className="num c-neg">−{won(d.amount)}</dd>
              </Fragment>
            ))}
            <dt>환불 금액</dt>
            <dd className="num fw7" data-testid="refund-amount">
              {blocked ? "—" : amount !== null ? won(amount) : fault === null ? "사유 주체를 선택하면 표시됩니다" : "금액을 확인하지 못했습니다"}
            </dd>
            {order.paymentMethod === "CARD" && (
              <>
                <dt>환불 수단</dt>
                <dd>원결제 카드 승인 취소</dd>
              </>
            )}
          </dl>
          {blocked && (
            <div className="msg msg-neg" role="alert" style={{ display: "block" }}>
              발송 전에 개봉한 상품이 있어 구매자 사정으로는 환불할 수 없습니다. 개봉한 상품을 보낸 뒤 처리해 주십시오
            </div>
          )}
          {nothing && (
            <div className="msg" role="status" style={{ display: "block" }}>
              <b>환불할 금액이 없습니다</b> 개봉한 상품과 배송비를 빼면 돌려줄 금액이 0원입니다
            </div>
          )}
          {needOpened && canSend && (
            <label className="chk">
              <input className="cbx" type="checkbox" checked={openedOk} disabled={busy} onChange={(e) => setOpenedOk(e.target.checked)} />
              개봉한 상품이 있는 것을 확인했습니다
            </label>
          )}
          {canSend && (
            <label className="chk">
              <input className="cbx" type="checkbox" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
              위 금액으로 환불합니다. 승인 취소 후 되돌릴 수 없습니다.
            </label>
          )}
          {error && (
            <div className="col" style={{ gap: 8, alignItems: "flex-start" }}>
              <div className="msg msg-neg" role="alert" style={{ display: "block", alignSelf: "stretch" }}>
                {error.retry ? (
                  <>
                    <b>{error.title}</b> {error.text}
                  </>
                ) : error.title ? (
                  <span className="col" style={{ gap: 2 }}>
                    <b>{error.title}</b>
                    <span>{error.text}</span>
                  </span>
                ) : (
                  error.text
                )}
              </div>
              {error.retry && (
                <button className="btn btn-sm" type="button" disabled={!ready} onClick={() => void submit()}>
                  다시 시도
                </button>
              )}
            </div>
          )}
        </section>

        <div className="modal-f">
          <button ref={closeRef} className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            닫기
          </button>
          {canSend && (
            <button className={`btn btn-neg${busy ? " is-loading" : ""}`} type="button" disabled={!ready} onClick={() => void submit()}>
              {busy ? (
                <>
                  <span className="spin" style={{ width: 16, height: 16, boxShadow: "inset 0 0 0 2px #ffffff66" }} />
                  환불 중
                </>
              ) : amount !== null ? (
                `${won(amount)} 환불 실행`
              ) : (
                "환불 실행"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
