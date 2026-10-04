"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { COURIERS } from "../../../lib/server/orders/shipping";
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
  createdAt: string;
  items: { orderItemId: string; productName: string; optionName: string; quantity: number }[];
};
type Ctx = { canRequest: boolean; blocked: string | null; items: { orderItemId: string; productName: string; optionName: string; quantity: number }[]; requests: Req[] };

const REASON: Record<Reason, string> = { CHANGE_OF_MIND: "단순 변심", DEFECTIVE: "상품 불량·파손", WRONG_ITEM: "다른 상품이 왔어요", NOT_AS_DESCRIBED: "상품 설명과 달라요", OTHER: "기타" };
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const KIND = { RETURN: "반품", EXCHANGE: "교환" } as const;
function statusText(r: Req): string {
  switch (r.status) {
    case "REQUESTED":
      return "신청했어요 · 판매자가 확인하고 있어요";
    case "ACCEPTED":
      return "접수됐어요 · 상품을 보내 주세요";
    case "RECEIVED":
      return "상품을 받았어요 · 처리하고 있어요";
    case "COMPLETED":
      return r.kind === "RETURN" ? `환불이 끝났어요${r.refundAmount !== null ? ` · ${won(r.refundAmount)}` : ""}` : `교환 상품을 보냈어요${r.exchangeTrackingNumber ? ` · ${r.exchangeCourierName} ${r.exchangeTrackingNumber}` : ""}`;
    case "REJECTED":
      return `거절됐어요${r.rejectReason ? ` · ${r.rejectReason}` : ""}`;
    case "CANCELLED":
      return "철회했어요";
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [courier, setCourier] = useState("CJ");
  const [tracking, setTracking] = useState("");
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setErr(null);
    const res = await call(`${base}/${r.id}/${path}`, { method: "POST", body });
    setBusy(false);
    if (!res.ok) return setErr(res.message ?? "처리하지 못했어요. 잠시 뒤 다시 해 주세요");
    await onDone(done);
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
      {r.status === "ACCEPTED" && (
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
              <button className="btn btn-sm" type="button" disabled={busy || tracking.trim().length < 4} onClick={() => void run("ship-back", { courier, trackingNumber: tracking }, "송장을 남겼어요")}>
                송장 저장
              </button>
            </>
          )}
        </div>
      )}
      {(r.status === "REQUESTED" || r.status === "ACCEPTED") && (
        <button className="btn btn-sm btn-out" type="button" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void run("cancel", {}, "신청을 철회했어요")}>
          신청 철회
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

function RequestForm({ base, orderId, items, onClose, onDone }: { base: string; orderId: string; items: Ctx["items"]; onClose: () => void; onDone: () => void | Promise<void> }) {
  const [kind, setKind] = useState<Kind>("RETURN");
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState<Reason | "">("");
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
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
    if (!r.ok) return setErr(r.message ?? "사진을 올리지 못했어요");
    setPhotos((p) => [...p, r.data.image]);
  };

  const ready = reason !== "" && (reason !== "OTHER" || text.trim() !== "") && (kind === "RETURN" || picked.length > 0);
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    const r = await call(base, {
      method: "POST",
      body: { orderId, kind, reason, reasonText: text, imageIds: photos.map((p) => p.id), ...(kind === "EXCHANGE" ? { orderItemIds: picked } : {}) },
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
          {busy ? "처리 중" : "신청하기"}
        </button>
      }
    >
      <div className="rtb-form">
        <fieldset>
          <legend>종류</legend>
          {(["RETURN", "EXCHANGE"] as const).map((k) => (
            <label key={k} className="rtb-check">
              <input type="radio" name="rtb-kind" checked={kind === k} onChange={() => setKind(k)} />
              {k === "RETURN" ? "반품 (주문 전체를 돌려보내고 환불)" : "교환 (골라서 같은 상품으로)"}
            </label>
          ))}
        </fieldset>
        {kind === "EXCHANGE" && (
          <fieldset>
            <legend>교환할 상품</legend>
            {items.map((i) => (
              <label key={i.orderItemId} className="rtb-check">
                <input type="checkbox" checked={picked.includes(i.orderItemId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, i.orderItemId] : p.filter((x) => x !== i.orderItemId)))} />
                <span>
                  {i.productName} · {i.optionName} × {i.quantity}
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
              <option key={k} value={k}>
                {REASON[k]}
              </option>
            ))}
          </select>
        </div>
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
