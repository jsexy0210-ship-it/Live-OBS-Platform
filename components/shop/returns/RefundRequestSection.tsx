"use client";

import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../../admin-ui/ConfirmDialog";
import ShopModal from "../ShopModal";
import { call, md } from "../reviewShared";
import "./returns.css";

// SH-022 주문 취소(환불) 요청(주문 상세 안). 결제 완료·발송 전·구매 확정 전 주문에 사유와 함께 요청하고(품목·수량을 고르거나 전부),
// 요청 단계에서는 철회할 수 있다. 판매자가 확인하면 그만큼 환불된다. API: /api/shop/{slug}/refund-requests (기반-결제 #415).
type Status = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
type Reason = "CHANGE_OF_MIND" | "DEFECTIVE" | "WRONG_ITEM" | "NOT_AS_DESCRIBED" | "OTHER";
type Req = { id: string; status: Status; reason: Reason; reasonLabel: string; reasonText: string | null; rejectReason: string | null; createdAt: string; decidedAt: string | null };
type Item = { orderItemId: string; productName: string; optionName: string; quantity: number };
type Ctx = { canRequest: boolean; blocked: string | null; items: Item[]; requests: Req[] };

const REASONS: [Reason, string][] = [
  ["CHANGE_OF_MIND", "단순 변심"],
  ["DEFECTIVE", "상품 불량·파손"],
  ["WRONG_ITEM", "다른 상품이 왔어요"],
  ["NOT_AS_DESCRIBED", "상품 설명과 달라요"],
  ["OTHER", "기타"],
];
const STATUS_TEXT: Record<Status, string> = { REQUESTED: "취소 요청", APPROVED: "승인됐어요", REJECTED: "거절됐어요", CANCELLED: "요청을 거뒀어요" };
const TEXT_MAX = 500;

export default function RefundRequestSection({ slug, orderId, onChanged }: { slug: string; orderId: string; onChanged?: () => void }) {
  const { confirm } = useConfirm();
  const base = `/api/shop/${encodeURIComponent(slug)}/refund-requests`;
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [form, setForm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await call<Ctx>(`${base}?orderId=${encodeURIComponent(orderId)}`);
    if (r.ok) setCtx(r.data);
  }, [base, orderId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function withdraw(id: string) {
    if (busy) return;
    const ok = await confirm({ tone: "shop", title: "취소 요청을 거둘까요?", body: "주문은 그대로 이어져요. 다시 취소하려면 새로 요청해야 해요.", confirmLabel: "요청 거두기", cancelLabel: "아니요" });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    const r = await call(`${base}/${id}/cancel`, { method: "POST" });
    setMsg(r.ok ? { ok: true, text: "요청을 거뒀어요" } : { ok: false, text: r.message ?? "요청을 거두지 못했어요. 잠시 뒤 다시 해 주세요" });
    await load();
    setBusy(false);
    if (r.ok) onChanged?.();
  }

  // 요청할 수 없고 지난 요청도 없으면 아무것도 보이지 않는다(발송 뒤에는 교환 · 반품 신청이 보인다)
  if (!ctx || (!ctx.canRequest && ctx.requests.length === 0 && ctx.blocked !== "shop_unavailable")) return null;
  return (
    <section className="co-box" aria-labelledby="od-rf">
      <h2 id="od-rf">주문 취소 요청</h2>
      {msg && (
        <p className={msg.ok ? "cart-msg" : "cart-msg is-err"} role="status">
          {msg.text}
        </p>
      )}
      {ctx.requests.map((r) => (
        <div key={r.id} className="rtb-item" data-testid="refund-request">
          <div className="rtb-row">
            <b>
              {STATUS_TEXT[r.status]} · {r.reasonLabel}
            </b>
            <span className="cart-opt">{md(r.createdAt)}</span>
          </div>
          {r.status === "REQUESTED" && <span className="cart-opt">판매자가 확인하면 바로 환불돼요</span>}
          {r.reason === "OTHER" && r.reasonText && <span className="cart-opt">{r.reasonText}</span>}
          {r.status === "REJECTED" && r.rejectReason && <span>거절 사유 · {r.rejectReason}</span>}
          {r.status === "REQUESTED" && (
            <button className="btn btn-sm btn-out" type="button" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void withdraw(r.id)}>
              취소 요청 거두기
            </button>
          )}
        </div>
      ))}
      {ctx.canRequest && (
        <>
          <button className="btn btn-sm" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setForm(true)}>
            주문 취소 요청
          </button>
          <p className="cart-opt" style={{ margin: "8px 0 0" }}>
            방송에서 상품을 열기 시작하면 취소할 수 없어요. 보낸 뒤에는 교환 · 반품을 신청해 주세요
          </p>
        </>
      )}
      {ctx.blocked === "active_exists" && <p className="cart-opt">진행 중인 요청이 끝나면 다시 요청할 수 있어요</p>}
      {ctx.blocked === "shop_unavailable" && <p className="cart-opt">지금은 요청할 수 없어요</p>}
      {form && (
        <RequestForm
          base={base}
          orderId={orderId}
          items={ctx.items}
          onClose={() => setForm(false)}
          onDone={async () => {
            setForm(false);
            setMsg({ ok: true, text: "요청했어요. 주문 상세에서 결과를 확인할 수 있어요" });
            await load();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

function RequestForm({ base, orderId, items, onClose, onDone }: { base: string; orderId: string; items: Item[]; onClose: () => void; onDone: () => void | Promise<void> }) {
  const [reason, setReason] = useState<Reason>("CHANGE_OF_MIND"); // 기본은 첫 사유
  const [text, setText] = useState("");
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(items.map((i) => [i.orderItemId, i.quantity]))); // 기본은 남은 품목 전부
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setErr(null), [reason, text, qty]); // 고친 뒤에는 이전 오류를 지운다
  const picked = items.filter((i) => (qty[i.orderItemId] ?? 0) > 0);
  const all = picked.length === items.length && picked.every((i) => qty[i.orderItemId] === i.quantity);
  const textErr = reason === "OTHER" && text.trim().length === 0 ? "자세한 사유를 적어 주세요" : null;
  const itemErr = picked.length === 0 ? "환불받을 상품을 하나 이상 골라 주세요" : null;

  async function submit() {
    if (busy || textErr || itemErr) return setErr(textErr ?? itemErr);
    setBusy(true);
    setErr(null);
    const r = await call(base, {
      method: "POST",
      body: { orderId, reason, ...(reason === "OTHER" ? { reasonText: text.trim() } : {}), ...(all ? {} : { items: picked.map((i) => ({ orderItemId: i.orderItemId, quantity: qty[i.orderItemId] })) }) },
    });
    if (!r.ok) {
      setErr(r.message ?? "요청하지 못했어요. 잠시 뒤 다시 해 주세요");
      return setBusy(false);
    }
    await onDone();
  }

  return (
    <ShopModal
      title="주문을 취소할까요?"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            아니요
          </button>
          <button className="btn" type="button" disabled={busy} aria-busy={busy} onClick={() => void submit()}>
            {busy ? "요청하고 있어요" : "취소 요청"}
          </button>
        </>
      }
    >
      <div className="rtb-form">
        <p style={{ margin: 0 }}>방송에서 상품을 열기 전까지만 취소할 수 있어요. 판매자가 확인하면 결제는 바로 환불돼요.</p>
        <fieldset>
          <legend>환불받을 상품</legend>
          {items.map((i) => (
            <div key={i.orderItemId} className="rtb-row">
              <label className="rtb-check">
                <input type="checkbox" checked={(qty[i.orderItemId] ?? 0) > 0} onChange={(e) => setQty((q) => ({ ...q, [i.orderItemId]: e.target.checked ? i.quantity : 0 }))} />
                <span>
                  {i.productName} <span className="cart-opt">{i.optionName}</span>
                </span>
              </label>
              {i.quantity > 1 && (qty[i.orderItemId] ?? 0) > 0 && (
                <select className="inp" style={{ width: 90 }} aria-label={`${i.productName} 수량`} value={qty[i.orderItemId]} onChange={(e) => setQty((q) => ({ ...q, [i.orderItemId]: Number(e.target.value) }))}>
                  {Array.from({ length: i.quantity }, (_, n) => n + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}개
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </fieldset>
        <fieldset>
          <legend>사유</legend>
          <select className="inp" aria-label="사유" value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
            {REASONS.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {reason === "OTHER" && (
            <textarea className="inp" aria-label="자세한 사유" rows={3} maxLength={TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="자세한 사유를 적어 주세요" style={{ height: "auto", padding: 8 }} />
          )}
        </fieldset>
        {err && (
          <p className="cart-msg is-err" role="alert" style={{ margin: 0 }}>
            {err}
          </p>
        )}
      </div>
    </ShopModal>
  );
}
