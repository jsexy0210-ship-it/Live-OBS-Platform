"use client";

import { useEffect, useRef, useState } from "react";
import { api, failMessage } from "./api";
import { won } from "./format";
import { longTime, type OrderDetail } from "./orders";

// SA-023 취소 · 환불 처리(모달). 전액 환불만 된다(API에 부분 환불 없음).
// 사유 주체(구매자 사정 / 판매자 사정)는 꼭 골라야 하고, 고르지 않으면 환불 버튼이 꺼져 있다.
// 환불 API는 주문대기 버전(expectedVersion)을 받으므로 보내기 직전에 /api/seller/queue/version을 읽는다.
type Fault = "BUYER" | "SELLER";
const FAULTS: { key: Fault; label: string; desc: string }[] = [
  { key: "BUYER", label: "구매자 사정", desc: "변심 · 잘못 주문" },
  { key: "SELLER", label: "판매자 사정", desc: "품절 · 오류" },
];
const REASONS = ["품절 · 재고 없음", "결제 오류 · 중복 결제", "기타"];

type Fail = { status: number; error: string; message?: string };

export default function RefundModal({ order, onClose, onDone }: { order: OrderDetail; onClose: () => void; onDone: (refundAmount: number) => void }) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [reason, setReason] = useState("");
  const [agree, setAgree] = useState(false);
  // 서버가 「개봉한 상품이 있어요」라고 하면 확인을 받은 뒤 confirmOpened로 다시 보낸다
  const [needOpened, setNeedOpened] = useState(false);
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

  const shipped = order.shipment !== null;
  // 발송한 주문을 구매자 사정으로 환불하면 반품 배송비가 빠질 수 있어 금액을 미리 확정하지 않는다
  const amountKnown = !(shipped && fault === "BUYER");
  const ready = fault !== null && reason !== "" && agree && (!needOpened || openedOk) && !busy;
  const first = order.items[0];
  const summary = first ? `${first.productNameSnapshot}${order.items.length > 1 ? ` 외 ${order.items.length - 1}건` : ` ×${first.quantity}`}` : "";

  const send = async (): Promise<{ ok: true; refundAmount: number } | { ok: false; fail: Fail }> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const v = await api<{ version: number }>("/api/seller/queue/version");
      if (!v.ok) return { ok: false, fail: v };
      const r = await api<{ refundAmount?: number }>(`/api/seller/orders/${order.id}/refund`, {
        method: "POST",
        body: { reason, expectedVersion: v.data.version, fault, confirmOpened: openedOk },
      });
      if (r.ok) return { ok: true, refundAmount: r.data.refundAmount ?? order.totalAmount };
      // 그사이 주문대기가 바뀌었으면(다른 화면·방송) 새 버전으로 한 번만 다시 보낸다
      if (r.error === "conflict" && attempt === 0) continue;
      return { ok: false, fail: r };
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
    const f = r.fail;
    if (f.error === "opened_items_present") {
      setNeedOpened(true);
      setError({ text: failMessage(f) });
    } else if (f.status === 403) setError({ title: "이 기능은 권한이 필요해요", text: "대표자에게 요청해 주세요 · 필요한 권한: 주문·배송" });
    else if (f.error === "invalid_transition") setError({ text: "이미 환불했거나 지금은 환불할 수 없는 주문이에요" });
    else if (f.error === "conflict") setError({ text: "그사이 주문대기가 바뀌었어요. 다시 눌러 주세요" });
    else if (f.message) setError({ text: f.message });
    else setError({ title: "환불하지 못했어요.", text: "결제는 그대로예요. 잠시 뒤 다시 시도해 주세요.", retry: true });
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
              <span className="t-l1 fw6">전액 환불</span>
              <span className="t-c1 c-alt">{order.paymentMethod === "CARD" ? `${won(order.totalAmount)} · 카드 승인 취소` : won(order.totalAmount)}</span>
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
                  <input className="rdo" type="radio" name="fault" value={f.key} checked={fault === f.key} disabled={busy} onChange={() => setFault(f.key)} />
                  <span className="col">
                    <span className="t-l1 fw6">{f.label}</span>
                    <span className="t-c1 c-alt">{f.desc}</span>
                  </span>
                </label>
              ))}
            </div>
            <span className="help">구매자 사정만 결제 후 취소 횟수에 들어가요 · 고르지 않으면 환불할 수 없어요</span>
            {fault === "BUYER" && <span className="t-c1 c-alt">이 취소는 구매자의 결제 후 취소 횟수에 들어가요</span>}
          </div>
          <div className="fld">
            <label htmlFor="refund-reason" className="req">
              처리 사유
            </label>
            <select id="refund-reason" className="inp" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}>
              <option value="" disabled>
                사유를 골라 주세요
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
            <dt>환불 금액</dt>
            <dd className="num fw7">{amountKnown ? won(order.totalAmount) : "반품 배송비를 빼고 환불해요"}</dd>
            {order.paymentMethod === "CARD" && (
              <>
                <dt>환불 수단</dt>
                <dd>원결제 카드 승인 취소</dd>
              </>
            )}
          </dl>
          {needOpened && (
            <label className="chk">
              <input className="cbx" type="checkbox" checked={openedOk} disabled={busy} onChange={(e) => setOpenedOk(e.target.checked)} />
              개봉한 상품이 있는 걸 확인했어요
            </label>
          )}
          <label className="chk">
            <input className="cbx" type="checkbox" checked={agree} disabled={busy} onChange={(e) => setAgree(e.target.checked)} />
            위 금액으로 환불해요. 승인 취소 후 되돌릴 수 없어요.
          </label>
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
          <button className={`btn btn-neg${busy ? " is-loading" : ""}`} type="button" disabled={!ready} onClick={() => void submit()}>
            {busy ? (
              <>
                <span className="spin" style={{ width: 16, height: 16, boxShadow: "inset 0 0 0 2px #ffffff66" }} />
                환불하고 있어요
              </>
            ) : amountKnown ? (
              `${won(order.totalAmount)} 환불 실행`
            ) : (
              "환불 실행"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
