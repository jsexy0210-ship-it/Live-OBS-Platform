"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { Modal } from "../admin-ui/Modal";
import { api, failMessage } from "./api";
import { won } from "./format";
import { longTime, type OrderDetail, type RefundFault as Fault, type RefundPreview } from "./orders";

// 부분 환불(품목·수량 선택): 고른 품목·수량으로 미리보기(POST …/refund/preview)를 다시 받아 금액을 보여 주고, 환불 요청에도 같은 items를 보낸다.
// 배송비는 마지막 환불에서만 돌려주고, 개봉 대기·개봉 중 품목은 남은 수량 전부만 고를 수 있다(서버 규칙).

// SA-023 취소 · 환불 처리(모달). 주문 전체 또는 일부 상품(수량)만 환불한다.
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
  // 환불 범위: 주문 전체(남은 상품 전부) 또는 일부 상품만(품목별 수량). 예전 응답처럼 품목 정보가 없으면 전체만
  const itemsInfo = order.refundPreview?.items ?? null;
  const [scope, setScope] = useState<"ALL" | "PART">("ALL");
  const [pick, setPick] = useState<Record<string, number>>({});
  const [previewing, setPreviewing] = useState(false);
  const selection = scope === "PART" ? Object.entries(pick).filter(([, q]) => q > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity })) : undefined;
  const selectionKey = JSON.stringify(selection ?? null);
  const firstRun = useRef(true);
  const previewSeq = useRef(0);
  // retry: 원인을 모르는 실패(서버 오류·연결 끊김)는 「다시 시도」로 같은 내용을 다시 보낸다
  const [error, setError] = useState<{ title?: string; text: string; retry?: boolean } | null>(null);

  // 범위·수량을 바꾸면 미리보기를 다시 받는다(늦게 온 옛 응답은 버린다). 처음 열 때는 주문 상세의 미리보기를 그대로 쓴다
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setAgree(false);
    if (scope === "PART" && (selection?.length ?? 0) === 0) {
      setPreview(null);
      return;
    }
    const n = ++previewSeq.current;
    setPreviewing(true);
    void api<RefundPreview>(`/api/seller/orders/${order.id}/refund/preview`, { method: "POST", body: { items: selection } }).then((r) => {
      if (n !== previewSeq.current) return;
      setPreviewing(false);
      if (r.ok) {
        setPreview(r.data);
        setError(null);
      } else {
        setPreview(null);
        setError({ text: r.message ?? "환불 금액을 불러오지 못했습니다. 상품과 수량을 확인해 주십시오" });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, selectionKey]);

  // 고른 사유 주체의 환불액. 고르기 전에는 두 사유 주체의 금액이 같을 때만 보인다. 미리보기가 없으면(예전 응답) 금액을 단정하지 않는다
  const quote = preview && fault ? preview.byFault[fault] : null;
  const same = preview && preview.byFault.BUYER.refundAmount === preview.byFault.SELLER.refundAmount ? preview.byFault.SELLER.refundAmount : null;
  const amount = quote ? quote.refundAmount : fault === null ? same : null;
  // 함께 적립금으로 돌려주는 금액(고르기 전에는 두 사유 주체가 같을 때만)
  const rewardReturn = quote
    ? (quote.rewardReturn ?? null)
    : preview && fault === null && preview.byFault.BUYER.rewardReturn === preview.byFault.SELLER.rewardReturn
      ? (preview.byFault.SELLER.rewardReturn ?? null)
      : null;
  const blocked = quote?.blocked === true;
  const nothing = quote !== null && !blocked && quote.refundAmount === 0;
  // 구매자 사정이면 빼는 항목(개봉한 상품, 발송했으면 처음 배송비·반품 배송비). 금액은 서버 계산(quote)이 기준이다
  const deductions =
    fault === "BUYER" && preview && !blocked
      ? [
          ...preview.openedItems.map((o) => ({ label: `개봉한 상품 · ${order.items.find((i) => i.id === o.orderItemId)?.productNameSnapshot ?? ""}`, amount: o.amount })),
          // 구매자가 실제로 낸 배송비(배송비 무료 쿠폰이면 0, 서버 미리보기 값)
          ...(preview.shipped && (preview.chargedShippingFee ?? order.shippingFee) > 0 ? [{ label: "처음 배송비", amount: preview.chargedShippingFee ?? order.shippingFee }] : []),
          ...(quote && quote.returnFeeDeducted > 0 ? [{ label: "반품 배송비", amount: quote.returnFeeDeducted }] : []),
        ]
      : [];
  const noPick = scope === "PART" && (selection?.length ?? 0) === 0;
  const canSend = !blocked && !nothing && !noPick;
  const ready = fault !== null && reason !== "" && agree && canSend && !previewing && (scope === "ALL" || preview !== null) && (!needOpened || openedOk) && !busy;
  const first = order.items[0];
  const summary = first ? `${first.productNameSnapshot}${order.items.length > 1 ? ` 외 ${order.items.length - 1}건` : ` ×${first.quantity}`}` : "";

  const chooseFault = (f: Fault) => {
    // 금액이 바뀌므로 「위 금액으로 환불해요」를 다시 받는다
    setFault(f);
    setAgree(false);
  };

  type Sent = { ok: true; refundAmount: number } | { ok: false; fail: Fail } | { ok: false; changed: RefundPreview | null; version: number };
  // 주문 상세를 다시 읽어 새 주문대기 버전과 미리보기를 받는다(일부 상품만이면 고른 상품·수량으로 미리보기를 다시 계산)
  const fresh = async (): Promise<{ ok: true; version: number; preview: RefundPreview | null } | { ok: false; fail: Fail }> => {
    const d = await api<{ queueVersion: number; refundPreview: RefundPreview | null }>(`/api/seller/orders/${order.id}`);
    if (!d.ok) return { ok: false, fail: d };
    if (scope === "ALL") return { ok: true, version: d.data.queueVersion, preview: d.data.refundPreview };
    const p = await api<RefundPreview>(`/api/seller/orders/${order.id}/refund/preview`, { method: "POST", body: { items: selection } });
    return { ok: true, version: d.data.queueVersion, preview: p.ok ? p.data : null };
  };
  const send = async (): Promise<Sent> => {
    let version = queueVersion;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await api<{ refundAmount?: number }>(`/api/seller/orders/${order.id}/refund`, {
        method: "POST",
        body: { reason, expectedVersion: version, fault, confirmOpened: openedOk, expectedRefundAmount: quote?.refundAmount, items: selection },
      });
      if (r.ok) return { ok: true, refundAmount: r.data.refundAmount ?? order.totalAmount };
      if (r.error === "refund_amount_changed") {
        const d = await fresh();
        if (!d.ok) return { ok: false, fail: r };
        return { ok: false, changed: d.preview, version: d.version };
      }
      if (r.error !== "conflict" || attempt === 1) return { ok: false, fail: r };
      // 그사이 주문대기가 바뀌었으면(다른 화면·방송) 상세를 다시 읽어 새 버전으로 한 번만 다시 보낸다
      const d = await fresh();
      if (!d.ok) return { ok: false, fail: d.fail };
      const next = d.preview;
      const nextQuote = next && fault ? next.byFault[fault] : null;
      // 확인받은 금액과 다르면(그사이 개봉·발송) 보내지 않는다
      if (preview && (!nextQuote || nextQuote.refundAmount !== quote?.refundAmount || nextQuote.blocked || next!.openedItems.length !== preview.openedItems.length)) {
        return { ok: false, changed: next, version: d.version };
      }
      version = d.version;
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
      setError({ text: failMessage(f, "admin") });
    } else if (f.status === 403) setError({ title: "이 기능은 권한이 필요합니다", text: "대표자에게 요청해 주십시오 · 필요한 권한: 주문·배송" });
    else if (f.error === "invalid_transition") setError({ text: "이미 환불했거나 지금은 환불할 수 없는 주문입니다" });
    else if (f.error === "conflict") setError({ text: "그사이 주문대기가 변경되었습니다. 다시 눌러 주십시오" });
    else if (f.message) setError({ text: f.message });
    else setError({ title: "환불하지 못했습니다.", text: "결제는 그대로입니다. 잠시 후 다시 시도해 주십시오.", retry: true });
  };

  return (
    <Modal labelId="refund-title" className="modal-lg refund-modal" busy={busy} onClose={onClose}>
      <>
        <div className="modal-h">
          <h2 className="modal-t" id="refund-title">
            취소 · 환불 처리
          </h2>
          <span className="t-l2 c-alt">
            {order.buyer.broadcastNickname} · {longTime(order.createdAt)} 주문{summary && ` · ${summary}`}
          </span>
        </div>

        <section className="col" style={{ gap: 10 }}>
          <h3 className="t-hl2">환불 범위</h3>
          <div className="refund-faults" role="radiogroup" aria-label="환불 범위">
            <label className={`refund-opt${scope === "ALL" ? " on" : ""}`}>
              <input className="rdo" type="radio" name="scope" checked={scope === "ALL"} disabled={busy} onChange={() => setScope("ALL")} />
              <span className="col">
                <span className="t-l1 fw6">{itemsInfo && itemsInfo.some((i) => i.refundedQuantity > 0) ? "남은 상품 전부 환불" : "주문 전체 환불"}</span>
                <span className="t-c1 c-alt">
                  {order.paymentMethod === "CARD" ? `${scope === "ALL" && canSend && amount ? `${won(amount)} · ` : ""}카드 승인 취소` : scope === "ALL" && canSend && amount ? won(amount) : "주문 전체 취소"}
                </span>
              </span>
            </label>
            {itemsInfo && itemsInfo.filter((i) => i.refundableQuantity > 0).length > 0 && (
              <label className={`refund-opt${scope === "PART" ? " on" : ""}`}>
                <input className="rdo" type="radio" name="scope" checked={scope === "PART"} disabled={busy} onChange={() => setScope("PART")} />
                <span className="col">
                  <span className="t-l1 fw6">일부 상품만</span>
                  <span className="t-c1 c-alt">상품과 수량을 골라 환불합니다</span>
                </span>
              </label>
            )}
          </div>
          {scope === "PART" && itemsInfo && (
            <table className="tbl" data-testid="refund-items">
              <thead>
                <tr>
                  <th scope="col" style={{ width: 44 }} aria-label="선택" />
                  <th scope="col">상품</th>
                  <th scope="col" style={{ width: 120 }}>
                    환불 수량
                  </th>
                  <th scope="col" style={{ width: 220 }}>
                    상태
                  </th>
                </tr>
              </thead>
              <tbody>
                {itemsInfo
                  .filter((i) => i.refundableQuantity > 0)
                  .map((i) => {
                    const q = pick[i.orderItemId] ?? 0;
                    const label = `${i.productName} ${i.optionName}`;
                    return (
                      <tr key={i.orderItemId} data-testid="refund-item">
                        <td>
                          <input
                            className="cbx"
                            type="checkbox"
                            aria-label={`${label} 선택`}
                            checked={q > 0}
                            disabled={busy}
                            onChange={(e) => setPick({ ...pick, [i.orderItemId]: e.target.checked ? i.refundableQuantity : 0 })}
                          />
                        </td>
                        <td className="l">
                          {i.productName}
                          <span className="t-c1 c-alt"> · {i.optionName}</span>
                        </td>
                        <td>
                          <span className="row" style={{ gap: 6, justifyContent: "center" }}>
                            <input
                              className="inp inp-sm"
                              style={{ width: 64 }}
                              type="number"
                              min={1}
                              max={i.refundableQuantity}
                              aria-label={`${label} 환불 수량`}
                              value={q || ""}
                              disabled={busy || q === 0 || i.queued}
                              onChange={(e) => setPick({ ...pick, [i.orderItemId]: Math.max(1, Math.min(i.refundableQuantity, Math.floor(Number(e.target.value)) || 1)) })}
                            />
                            <span className="t-c1 c-alt num">/ {i.refundableQuantity}</span>
                          </span>
                        </td>
                        <td>
                          {i.opened ? <span className="bdg b-gray nodot">개봉</span> : i.queued ? <span className="bdg b-info">개봉 대기</span> : <span className="bdg b-done">개봉 전</span>}
                          {i.queued && <span className="t-c1 c-alt"> · 전체 수량만</span>}
                          {i.refundedQuantity > 0 && <span className="t-c1 c-alt"> · {i.refundedQuantity}개 환불함</span>}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          )}
          {noPick && <span className="t-c1 c-alt">환불할 상품을 골라 주십시오</span>}
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
            {preview && !blocked && (scope === "PART" || (preview.refundedAmount ?? 0) > 0) && quote && quote.itemsAmount !== undefined && (
              <>
                {(preview.refundedAmount ?? 0) > 0 && (
                  <>
                    <dt>이미 환불한 금액</dt>
                    <dd className="num">{won(preview.refundedAmount ?? 0)}</dd>
                  </>
                )}
                <dt>이번 상품 금액</dt>
                <dd className="num" data-testid="refund-items-amount">
                  {won(quote.itemsAmount)}
                </dd>
                <dt>배송비 환불</dt>
                <dd className="num" data-testid="refund-shipping">
                  {(quote.shippingRefunded ?? 0) > 0 ? won(quote.shippingRefunded ?? 0) : preview.isFinal === false ? "마지막 환불에서 돌려줍니다" : "0원"}
                </dd>
              </>
            )}
            <dt>현금 환불</dt>
            <dd className="num fw7" data-testid="refund-amount">
              {blocked ? "—" : amount !== null ? won(amount) : fault === null ? "사유 주체를 선택하면 표시됩니다" : "금액을 확인하지 못했습니다"}
            </dd>
            {rewardReturn !== null && !blocked && (
              <>
                <dt>적립금 반환</dt>
                <dd className="num" data-testid="refund-reward">
                  {rewardReturn > 0 ? `${won(rewardReturn)} · 적립금으로 반환` : (order.rewardUsedAmount > 0 ? "0원" : "0원 (사용한 적립금 없음)")}
                </dd>
              </>
            )}
            {preview?.rewardRevoke && preview.rewardRevoke.amount > 0 && !blocked && (
              <>
                <dt>적립 회수</dt>
                <dd className="num" data-testid="refund-revoke">
                  {preview.rewardRevoke.kind === "manual" ? `${won(preview.rewardRevoke.amount)} · 수동 확인 필요` : `−${won(preview.rewardRevoke.amount)}${preview.rewardRevoke.kind === "pending" ? " · 지급 대기분 취소" : " · 지급한 적립금에서 회수"}`}
                </dd>
              </>
            )}
            {order.paymentMethod === "CARD" && (
              <>
                <dt>환불 수단</dt>
                <dd>원결제 카드 승인 취소</dd>
              </>
            )}
          </dl>
          {rewardReturn !== null && rewardReturn > 0 && !blocked && <span className="t-c1 c-alt">쓴 적립금은 구매자에게 적립금으로 돌려줍니다</span>}
          {preview?.isFinal !== undefined && scope === "PART" && !blocked && !noPick && (
            <span className="t-c1 c-alt" data-testid="refund-final">
              {preview.isFinal ? "이번 환불로 주문 전체가 환불 처리됩니다" : "이번 환불 뒤에도 주문은 결제 완료로 남고, 남은 상품은 다시 환불할 수 있습니다"}
            </span>
          )}
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
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            취소
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
      </>
    </Modal>
  );
}
