"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COURIERS } from "../../../lib/server/orders/shipping";
import { useConfirm } from "../../admin-ui/ConfirmDialog";
import ShopModal from "../ShopModal";
import { call, md, reencodePhoto } from "../reviewShared";
import "./returns.css";

// SH-022-R 교환 · 반품 신청(주문 상세 안). 배송 완료 뒤 구매 확정 전의 주문에서 반품(주문 전체) 또는 교환(상품 선택)을 신청하고,
// 진행 상태를 보고 접수 뒤에는 돌려보낼 송장을 남기며, 신청 · 접수 단계에서는 철회할 수 있다. API: /api/shop/{slug}/returns.
type Status = "REQUESTED" | "ACCEPTED" | "RECEIVED" | "COMPLETED" | "REJECTED" | "CANCELLED";
type Kind = "RETURN" | "EXCHANGE";
type Reason = "CHANGE_OF_MIND" | "DEFECTIVE" | "WRONG_ITEM" | "NOT_AS_DESCRIBED" | "OTHER";
type Req = {
  id: string;
  kind: Kind;
  status: Status;
  reason: Reason;
  reasonText: string;
  rejectReason: string | null;
  returnTrackingNumber: string | null;
  exchangeCourierName: string | null;
  exchangeTrackingNumber: string | null;
  refundAmount: number | null;
  pickupMethod: "COURIER" | "BUYER_SHIP" | "NONE";
  inspectionResult: "OK" | "USED_DAMAGED" | "MISSING_PARTS" | null;
  exchangeHeldAt: string | null;
  convertedFromExchange: boolean;
  createdAt: string;
  items: { orderItemId: string; productName: string; optionName: string; quantity: number; orderQuantity: number }[];
};
type RefundLine = { seq: number; createdAt: string; refundAmount: number; returnFeeDeducted: number; rewardReturn: number; items: { quantity: number; productName: string; optionName: string }[] };
type Ctx = {
  refunds: RefundLine[];
  canRequest: boolean;
  blocked: string | null;
  deadline: string | null;
  windowOpen: boolean;
  needsRefundAccount: boolean;
  items: { orderItemId: string; productName: string; optionName: string; quantity: number; opened: boolean }[];
  requests: Req[];
};

const REASON: Record<Reason, string> = { CHANGE_OF_MIND: "단순 변심", DEFECTIVE: "상품 불량·파손", WRONG_ITEM: "다른 상품이 왔어요", NOT_AS_DESCRIBED: "상품 설명과 달라요", OTHER: "기타" };
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const KIND = { RETURN: "반품", EXCHANGE: "교환" } as const;
function statusText(r: Req): string {
  switch (r.status) {
    case "REQUESTED":
      return "신청했어요 · 판매자가 확인하고 있어요";
    case "ACCEPTED":
      return r.pickupMethod === "COURIER" ? "접수됐어요 · 택배 수거를 준비하고 있어요" : r.pickupMethod === "NONE" ? "접수됐어요 · 상품은 보내지 않아도 돼요" : "접수됐어요 · 상품을 보내 주세요";
    case "RECEIVED":
      if (r.exchangeHeldAt) return "상품을 받았어요 · 교환 상품이 다시 들어오면 보내 드려요";
      if (r.convertedFromExchange) return "교환 상품 재고가 없어 환불로 바뀌었어요 · 처리하고 있어요";
      return r.inspectionResult ? "상품을 받았어요 · 확인을 마치고 환불을 준비하고 있어요" : "상품을 받았어요 · 상태를 확인하고 있어요";
    case "COMPLETED":
      return r.kind === "RETURN" ? `환불이 끝났어요${r.refundAmount !== null ? ` · ${won(r.refundAmount)}` : ""}` : `교환 상품을 보냈어요${r.exchangeTrackingNumber ? ` · ${r.exchangeCourierName} ${r.exchangeTrackingNumber}` : ""}`;
    case "REJECTED":
      return `거절됐어요${r.rejectReason ? ` · ${r.rejectReason}` : ""}`;
    case "CANCELLED":
      return "신청을 거뒀어요";
  }
}

export default function ReturnSection({ slug, orderId }: { slug: string; orderId: string }) {
  const base = `/api/shop/${encodeURIComponent(slug)}/returns`;
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [form, setForm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call<Ctx>(`${base}?orderId=${encodeURIComponent(orderId)}`);
    if (r.ok) setCtx(r.data);
  }, [base, orderId]);
  useEffect(() => {
    void load();
  }, [load]);

  // 신청할 수 없고 지난 신청도 없으면 아무것도 보이지 않는다
  if (!ctx || (!ctx.canRequest && ctx.requests.length === 0)) return null;
  return (
    <section className="co-box" aria-labelledby="od-rt">
      <h2 id="od-rt">교환 · 반품</h2>
      {msg && (
        <p className="cart-msg" role="status">
          {msg}
        </p>
      )}
      {ctx.requests.map((r) => (
        <RequestItem
          key={r.id}
          r={r}
          base={base}
          onDone={async (text) => {
            setMsg(text);
            await load();
          }}
        />
      ))}
      {ctx.refunds.length > 0 && (
        <div className="rtb-item" data-testid="refund-history">
          <b>환불 내역</b>
          {ctx.refunds.map((f) => (
            <span key={f.seq} className="cart-opt">
              {md(f.createdAt)} · {f.items.map((i) => `${i.productName} × ${i.quantity}`).join(", ")} · {won(f.refundAmount)} 환불
              {f.returnFeeDeducted > 0 ? ` (반품 배송비 ${won(f.returnFeeDeducted)} 뺌)` : ""}
              {f.rewardReturn > 0 ? ` · 적립금 ${won(f.rewardReturn)} 돌려받음` : ""}
            </span>
          ))}
        </div>
      )}
      {ctx.canRequest && (
        <button className="btn btn-sm btn-out" type="button" style={{ alignSelf: "flex-start" }} onClick={() => setForm(true)}>
          교환 · 반품 신청
        </button>
      )}
      {!ctx.canRequest && ctx.blocked === "active_exists" && <p className="cart-opt">진행 중인 신청이 끝나면 다시 신청할 수 있어요</p>}
      {form && (
        <RequestForm
          base={base}
          orderId={orderId}
          items={ctx.items}
          deadline={ctx.deadline}
          windowOpen={ctx.windowOpen}
          needsRefundAccount={ctx.needsRefundAccount}
          onClose={() => setForm(false)}
          onDone={async () => {
            setForm(false);
            setMsg("신청했어요. 판매자가 확인하면 알려 드릴게요");
            await load();
          }}
        />
      )}
    </section>
  );
}

function RequestItem({ r, base, onDone }: { r: Req; base: string; onDone: (text: string) => void | Promise<void> }) {
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [courier, setCourier] = useState("CJ");
  const [tracking, setTracking] = useState("");
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setErr(null);
    const res = await call(`${base}/${r.id}/${path}`, { method: "POST", body });
    setBusy(false);
    if (!res.ok) return setErr(res.message ?? "신청을 처리하지 못했어요. 잠시 뒤 다시 눌러 주세요");
    await onDone(done);
  };
  const askShip = async () => {
    const courierName = COURIERS[courier as keyof typeof COURIERS] ?? courier;
    const ok = await confirm({ tone: "shop", title: "보낸 송장을 남길까요?", body: `${courierName} ${tracking.trim()}를 판매자에게 알려요.`, confirmLabel: "남기기" });
    if (ok) await run("ship-back", { courier, trackingNumber: tracking }, "송장을 남겼어요");
  };
  const askCancel = async () => {
    const ok = await confirm({ tone: "shop", title: "신청을 거둘까요?", body: "교환·반품 신청이 끝나요. 다시 하려면 새로 신청해야 해요.", confirmLabel: "신청 거두기", cancelLabel: "아니요" });
    if (ok) await run("cancel", {}, "신청을 철회했어요");
  };
  return (
    <div className="rtb-item" data-testid="return-item">
      <div className="rtb-row">
        <b>
          {KIND[r.kind]} · {REASON[r.reason]}
        </b>
        <span className="cart-opt">{md(r.createdAt)}</span>
      </div>
      <span>{statusText(r)}</span>
      <span className="cart-opt">{r.items.map((i) => `${i.productName} × ${i.quantity}`).join(", ")}</span>
      {r.status === "ACCEPTED" && r.pickupMethod === "BUYER_SHIP" && (
        <div className="rtb-row" style={{ flexWrap: "wrap", justifyContent: "flex-start" }}>
          {r.returnTrackingNumber ? (
            <span className="cart-opt">보낸 송장 {r.returnTrackingNumber}</span>
          ) : (
            <>
              <select className="inp" style={{ width: 130 }} aria-label="택배사" value={courier} onChange={(e) => setCourier(e.target.value)}>
                {Object.entries(COURIERS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <input className="inp" style={{ flex: 1, minWidth: 140 }} aria-label="송장 번호" placeholder="보낸 송장 번호" maxLength={40} value={tracking} onChange={(e) => setTracking(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))} />
              <button className="btn btn-sm" type="button" disabled={busy || tracking.trim().length < 4} onClick={() => void askShip()}>
                송장 저장
              </button>
            </>
          )}
        </div>
      )}
      {(r.status === "REQUESTED" || r.status === "ACCEPTED") && (
        <button className="btn btn-sm btn-out" type="button" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void askCancel()}>
          신청 거두기
        </button>
      )}
      {err && (
        <span className="cart-msg" role="alert">
          {err}
        </span>
      )}
    </div>
  );
}

type Photo = { id: string; url: string };

const SELLER_FAULT: Reason[] = ["DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED"];

function RequestForm({
  base,
  orderId,
  items,
  deadline,
  windowOpen,
  needsRefundAccount,
  onClose,
  onDone,
}: {
  base: string;
  orderId: string;
  items: Ctx["items"];
  deadline: string | null;
  windowOpen: boolean;
  needsRefundAccount: boolean;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { confirm } = useConfirm();
  const [kind, setKind] = useState<Kind>("RETURN");
  const [picked, setPicked] = useState<string[]>([]);
  // 반품: 상품별로 돌려보낼 수량(0이면 제외). 처음에는 전부
  const [qty, setQty] = useState<Record<string, number>>(() => Object.fromEntries(items.map((i) => [i.orderItemId, i.quantity])));
  const [reason, setReason] = useState<Reason | "">("");
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [pickup, setPickup] = useState<"BUYER_SHIP" | "COURIER">("BUYER_SHIP");
  const [bank, setBank] = useState({ bankName: "", accountHolder: "", accountNumber: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const addPhoto = async (f: File) => {
    setErr(null);
    const blob = await reencodePhoto(f);
    if (!blob) return setErr("사진을 읽지 못했어요. 다른 사진으로 해 주세요");
    setBusy(true);
    const r = await call<{ image: Photo }>(`${base}/images`, { method: "POST", raw: blob });
    setBusy(false);
    if (!r.ok) return setErr(r.message ?? "사진을 올리지 못했어요. 다른 사진으로 다시 올려 주세요");
    setPhotos((p) => [...p, r.data.image]);
  };

  // 포장을 뜯은 상품은 단순 변심으로 신청할 수 없다(교환은 고른 것 중 하나라도, 반품은 전부 개봉일 때). 기한이 지나면 불량·오배송·설명과 달라요만 받는다.
  const target = kind === "EXCHANGE" ? items.filter((i) => picked.includes(i.orderItemId)) : items.filter((i) => (qty[i.orderItemId] ?? 0) > 0);
  const openedHit = target.filter((i) => i.opened).length;
  const openedBlocked = openedHit > 0 && (kind === "EXCHANGE" || openedHit === target.length);
  const allowed = (k: Reason) => (SELLER_FAULT.includes(k) ? true : windowOpen && !(k === "CHANGE_OF_MIND" && openedBlocked));
  const accountOk = !needsRefundAccount || (bank.bankName.trim() !== "" && bank.accountHolder.trim() !== "" && /^[0-9-]{6,20}$/.test(bank.accountNumber.trim()));
  const ready = reason !== "" && allowed(reason) && accountOk && (reason !== "OTHER" || text.trim() !== "") && (kind === "RETURN" ? target.length > 0 : picked.length > 0);
  const whole = items.every((i) => (qty[i.orderItemId] ?? 0) === i.quantity);
  const submit = async () => {
    if (!ready || busy) return;
    const what = kind === "RETURN" ? "반품" : "교환";
    const count = kind === "EXCHANGE" ? picked.length : target.length;
    const ok = await confirm({ tone: "shop", title: `${what}을 신청할까요?`, body: `상품 ${count}종을 ${what}으로 신청해요. 판매자가 확인하면 알려 드려요.`, confirmLabel: "신청하기" });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    const r = await call(base, {
      method: "POST",
      body: { orderId, kind, reason, reasonText: text, pickup, imageIds: photos.map((p) => p.id), ...(kind === "EXCHANGE" ? { orderItemIds: picked } : whole ? {} : { items: target.map((i) => ({ orderItemId: i.orderItemId, quantity: qty[i.orderItemId] })) }), ...(needsRefundAccount ? { refundAccount: bank } : {}) },
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message ?? "신청하지 못했어요. 잠시 뒤 다시 해 주세요");
    await onDone();
  };

  return (
    <ShopModal
      title="교환 · 반품 신청"
      onClose={onClose}
      busy={busy}
      footer={
        <button className="btn btn-block" type="button" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? "신청하고 있어요" : "신청하기"}
        </button>
      }
    >
      <div className="rtb-form">
        <fieldset>
          <legend>종류</legend>
          {(["RETURN", "EXCHANGE"] as const).map((k) => (
            <label key={k} className="rtb-check">
              <input type="radio" name="rtb-kind" checked={kind === k} onChange={() => setKind(k)} />
              {k === "RETURN" ? "반품 (돌려보낼 상품을 골라 환불)" : "교환 (같은 상품으로 다시 받기)"}
            </label>
          ))}
        </fieldset>
        {kind === "RETURN" && (
          <fieldset>
            <legend>돌려보낼 상품</legend>
            {items.map((i) => (
              <label key={i.orderItemId} className="rtb-check">
                <select
                  className="inp"
                  style={{ width: 72 }}
                  aria-label={`${i.productName} 수량`}
                  value={qty[i.orderItemId] ?? 0}
                  onChange={(e) => setQty({ ...qty, [i.orderItemId]: Number(e.target.value) })}
                >
                  {Array.from({ length: i.quantity + 1 }, (_, n) => (
                    <option key={n} value={n}>
                      {n}개
                    </option>
                  ))}
                </select>
                <span>
                  {i.productName} · {i.optionName} (최대 {i.quantity}개)
                  {i.opened ? " (포장을 뜯음)" : ""}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {kind === "EXCHANGE" && (
          <fieldset>
            <legend>교환할 상품</legend>
            {items.map((i) => (
              <label key={i.orderItemId} className="rtb-check">
                <input type="checkbox" checked={picked.includes(i.orderItemId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i.orderItemId] : p.filter((x) => x !== i.orderItemId)))} />
                <span>
                  {i.productName} · {i.optionName} × {i.quantity}
                  {i.opened ? " (포장을 뜯음)" : ""}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="fld">
          <label htmlFor="rtb-reason">사유</label>
          <select id="rtb-reason" className="inp" value={reason} onChange={(e) => setReason(e.target.value as Reason | "")}>
            <option value="">사유를 골라 주세요</option>
            {(Object.keys(REASON) as Reason[]).map((k) => (
              <option key={k} value={k} disabled={!allowed(k)}>
                {REASON[k]}
              </option>
            ))}
          </select>
          {deadline && (
            <span className="cart-opt" data-testid="rt-deadline">
              {windowOpen ? `배송 완료 뒤 7일 안에 신청할 수 있어요 (${md(deadline)}까지)` : "신청 기간(배송 완료 뒤 7일)이 지났어요. 불량·오배송은 아직 신청할 수 있어요"}
            </span>
          )}
          {openedBlocked && <span className="cart-opt">포장을 뜯은 상품은 단순 변심으로 신청할 수 없어요. 불량·오배송은 사유를 골라 신청해 주세요</span>}
        </div>
        <fieldset>
          <legend>상품 보내는 방법</legend>
          {([["BUYER_SHIP", "직접 보낼게요"], ["COURIER", "택배 수거를 원해요"]] as const).map(([k, label]) => (
            <label key={k} className="rtb-check">
              <input type="radio" name="rtb-pickup" checked={pickup === k} onChange={() => setPickup(k)} />
              {label}
            </label>
          ))}
        </fieldset>
        {needsRefundAccount && (
          <fieldset>
            <legend>환불받을 계좌</legend>
            <div className="fld">
              <label htmlFor="rtb-bank">은행</label>
              <input id="rtb-bank" className="inp" maxLength={20} value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} />
            </div>
            <div className="fld">
              <label htmlFor="rtb-holder">예금주</label>
              <input id="rtb-holder" className="inp" maxLength={20} value={bank.accountHolder} onChange={(e) => setBank({ ...bank, accountHolder: e.target.value })} />
            </div>
            <div className="fld">
              <label htmlFor="rtb-acct">계좌번호</label>
              <input id="rtb-acct" className="inp" inputMode="numeric" maxLength={20} value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value.replace(/[^0-9-]/g, "") })} />
              <span className="cart-opt">환불이 끝나면 계좌 정보는 지워져요</span>
            </div>
          </fieldset>
        )}
        <div className="fld">
          <label htmlFor="rtb-text">자세한 사유{reason === "OTHER" ? "" : " (선택)"}</label>
          <textarea id="rtb-text" className="inp" style={{ height: 96, padding: "10px 12px" }} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="어떤 점이 문제인지 알려 주세요" />
        </div>
        <div className="fld">
          <label>사진 (선택, 5장까지)</label>
          <div className="rtb-photos">
            {photos.map((p) => (
              <span key={p.id} className="rtb-ph">
                <img src={p.url} alt="올린 사진" />
                <button className="rtb-x" type="button" aria-label="사진 지우기" onClick={() => setPhotos((x) => x.filter((y) => y.id !== p.id))}>
                  ×
                </button>
              </span>
            ))}
            {photos.length < 5 && (
              <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => file.current?.click()}>
                사진 올리기
              </button>
            )}
          </div>
          <input
            ref={file}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            aria-label="사진 파일"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void addPhoto(f);
            }}
          />
        </div>
        {err && (
          <p className="cart-msg" role="alert">
            {err}
          </p>
        )}
      </div>
    </ShopModal>
  );
}
