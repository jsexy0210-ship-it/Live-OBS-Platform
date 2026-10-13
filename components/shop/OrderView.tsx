"use client";

import ShopBack from "./ShopBack";
import Link from "next/link";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import OrderPay from "./OrderPay";
import RefundRequestSection from "./returns/RefundRequestSection";
import ReturnSection from "./returns/ReturnSection";
import { call } from "./reviewShared";
import { trackingUrl } from "./trackingLink";
import { qtyText } from "./orderFormat";
import { formatDateTime } from "../../lib/client/format";
import "./Cart.css";
import "./Checkout.css";

// SH-007 주문 완료 · 주문 상세(시안 04 SH). 본인 주문을 /api/shop/{slug}/orders/{id}로 읽는다. ?done=1이면 방금 주문한 안내를 위에 둔다.
type Order = {
  id: string;
  orderNo: number;
  orderNoLabel: string;
  status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";
  totalAmount: number;
  shippingFee: number;
  createdAt: string;
  paymentDueAt: string | null;
  couponRedemption: { discountAmount: number; restoredAt: string | null; coupon: { name: string } } | null;
  refundAmount: number | null;
  items: { productNameSnapshot: string; optionNameSnapshot: string; unitPrice: number; quantity: number; refundedQuantity?: number; imageUrl?: string | null }[];
  queue?: { status: "WAITING" | "OPENING" | "DONE"; aheadCount: number } | null;
  fulfillmentType?: "IMMEDIATE" | "STORAGE";
  paymentInfo?: { method: "CARD" | "BANK_TRANSFER"; card: { name: string | null; last4: string | null; installment: number | null } | null };
  cashReceipt?: { requested: boolean };
  shipment: { courier: string; courierName: string; trackingNumber: string; status: "READY" | "IN_TRANSIT" | "DELIVERED"; shippedAt: string; deliveredAt: string | null } | null;
  shippingAddress: { recipientName: string; phone: string; zipCode: string; address1: string; address2: string | null; memo: string | null } | null;
};
type View = { kind: "loading" } | { kind: "login" } | { kind: "missing" } | { kind: "error" } | { kind: "ok"; order: Order };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const SHIP = { READY: "배송 준비 중", IN_TRANSIT: "배송 중", DELIVERED: "배송 완료" } as const;
const PAY_NOTE: Record<string, { ok: boolean; text: string }> = {
  paid: { ok: true, text: "결제가 끝났어요." },
  failed: { ok: false, text: "결제가 되지 않았어요. 아래에서 결제 방법을 골라 다시 결제해 주세요." },
  pending: { ok: true, text: "결제를 확인하고 있어요. 잠시 뒤 주문 상태가 바뀌어요." },
  cancelled: { ok: false, text: "주문이 이미 취소돼 결제 금액을 돌려 드렸어요." },
};
const STATUS = { PENDING_PAYMENT: "결제 전", PAID: "결제 완료", CANCELLED: "취소했어요", REFUNDED: "환불했어요" } as const;
const payMethodText = (p: NonNullable<Order["paymentInfo"]>) => {
  if (p.method === "BANK_TRANSFER") return "무통장 입금";
  if (!p.card) return "카드";
  const inst = p.card.installment && p.card.installment > 1 ? `${p.card.installment}개월 할부` : p.card.installment !== null ? "일시불" : "";
  return [`카드${p.card.last4 ? ` ****-${p.card.last4}` : ""}`, inst].filter(Boolean).join(" · ");
};
export default function OrderView({ slug, orderId }: { slug: string; orderId: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const sp = useSearchParams();
  const done = sp.get("done") === "1";
  const payNote = PAY_NOTE[sp.get("payment") ?? ""];
  const [view, setView] = useState<View>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [tick, setTick] = useState(0); // 환불 요청을 하거나 철회하면 주문을 다시 읽는다

  useEffect(() => {
    let live = true;
    call<Order>(`/api/shop/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}`).then((r) => {
      if (!live) return;
      setView(r.ok ? { kind: "ok", order: r.data } : { kind: r.status === 401 ? "login" : r.status === 404 ? "missing" : "error" });
    });
    return () => {
      live = false;
    };
  }, [slug, orderId, tick]);

  async function copyNo(no: string) {
    try {
      await navigator.clipboard.writeText(no);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const wrap = (body: React.ReactNode, title = "주문 상세") => (
    <div className="shop-wrap cart-wrap">
      <ShopBack fallback={`/shop/${encodeURIComponent(slug)}/orders`} label="주문 내역" />
      <div className="cart-head">
        <h1>{title}</h1>
        {done && (
          <ol className="cart-steps" aria-label="주문 단계">
            <li>
              <i>01</i>장바구니
            </li>
            <li>
              <i>02</i>주문서
            </li>
            <li aria-current="step">
              <i>03</i>주문 완료
            </li>
          </ol>
        )}
      </div>
      {body}
    </div>
  );

  if (view.kind === "loading") return <div aria-busy="true">{wrap(<p className="shop-empty">주문을 불러오고 있어요</p>)}</div>;
  if (view.kind !== "ok")
    return wrap(
      <div className="cart-empty">
        <p>
          {view.kind === "login" ? "로그인하면 주문을 볼 수 있어요." : view.kind === "missing" ? "찾을 수 없는 주문이에요." : "주문을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요."}
        </p>
        <Link className="btn" href={view.kind === "login" ? `${base}/login?next=${encodeURIComponent(`${base}/orders/${orderId}`)}` : base}>
          {view.kind === "login" ? "로그인" : "쇼핑몰 홈으로"}
        </Link>
      </div>,
    );

  const o = view.order;
  const itemsTotal = o.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const discount = o.couponRedemption && !o.couponRedemption.restoredAt ? o.couponRedemption.discountAmount : 0;
  // 결제 금액 = 상품 + 배송비 − 쿠폰 − 적립금이므로 적립금 사용액은 차이로 구한다(주문 응답에 따로 없음)
  const rewardUsed = Math.max(0, itemsTotal + o.shippingFee - (o.couponRedemption?.discountAmount ?? 0) - o.totalAmount);
  return wrap(
    <div className="co-main">
      {done && (
        <p className="cart-msg" role="status">
          <b>주문이 접수됐어요.</b> {o.status === "PENDING_PAYMENT" ? "아래에서 결제 수단을 골라 결제해 주세요." : ""}
        </p>
      )}
      {payNote && (
        <p className={payNote.ok ? "cart-msg" : "cart-msg is-err"} role="status">
          {payNote.text}
        </p>
      )}
      <section className="co-box od-head" aria-label="주문 요약">
        <p className="od-headline">
          <span>{formatDateTime(o.createdAt)} 주문</span>
          <span className="od-chip">{STATUS[o.status]}</span>
        </p>
        <p className="od-no">
          주문번호 <b>{o.orderNoLabel}</b>
          <button type="button" className="shop-linkbtn" onClick={() => void copyNo(o.orderNoLabel)}>
            복사
          </button>
        </p>
        {copied && (
          <p className="cart-hint" role="status">
            주문번호를 복사했어요
          </p>
        )}
        {o.status === "PENDING_PAYMENT" && o.paymentDueAt && <p className="cart-hint">결제 기한 {formatDateTime(o.paymentDueAt)}</p>}
      </section>
      {o.status === "PENDING_PAYMENT" && <OrderPay slug={slug} orderId={o.id} amount={o.totalAmount} dueAt={o.paymentDueAt} />}
      {o.status === "PAID" && o.queue && (
        <section className="co-box" aria-label="주문 진행">
          <ol className="od-steps">
            <li className="is-done">
              <b>주문 접수</b>
              <span>{formatDateTime(o.createdAt)}</span>
            </li>
            <li className={o.queue.status === "WAITING" ? "is-now" : "is-done"}>
              <b>개봉 대기</b>
              <span>{o.queue.status === "WAITING" ? `앞에 ${o.queue.aheadCount}명` : "끝났어요"}</span>
            </li>
            <li className={o.queue.status === "OPENING" ? "is-now" : o.queue.status === "DONE" ? "is-done" : ""}>
              <b>개봉 · 결과</b>
              <span>{o.queue.status === "DONE" ? "개봉이 끝났어요" : o.queue.status === "OPENING" ? "방송에서 열고 있어요" : "방송에서 열어요"}</span>
            </li>
          </ol>
        </section>
      )}
      <section className="co-box" aria-labelledby="od-items">
        <h2 id="od-items">
          주문 상품 <span>{o.items.length}개</span>
        </h2>
        <ul className="co-lines">
          {o.items.map((i, n) => (
            <li key={n}>
              <span className="ol-thumb" aria-hidden="true">
                {i.imageUrl && <Image src={i.imageUrl} alt="" width={48} height={48} unoptimized />}
              </span>
              <div>
                <b>{i.productNameSnapshot}</b>
                <span className="cart-opt">
                  {qtyText(i.optionNameSnapshot, i.quantity)}
                  {(i.refundedQuantity ?? 0) > 0 ? ` · 환불 ${i.refundedQuantity}개` : ""}
                </span>
              </div>
              <b>{won(i.unitPrice * i.quantity)}</b>
            </li>
          ))}
        </ul>
      </section>
      <section className="co-box" aria-labelledby="od-sum">
        <h2 id="od-sum">결제 정보</h2>
        <div className="cart-row">
          <span>상품 금액</span>
          <span>{won(itemsTotal)}</span>
        </div>
        <div className="cart-row">
          <span>배송비</span>
          <span>{won(o.shippingFee)}</span>
        </div>
        <div className="cart-row">
          <span>쿠폰 할인</span>
          <span>{discount > 0 ? `−${won(discount)} · ${o.couponRedemption!.coupon.name}` : "0원 · 안 썼어요"}</span>
        </div>
        {rewardUsed > 0 && (
          <div className="cart-row">
            <span>적립금 사용</span>
            <span>−{won(rewardUsed)}</span>
          </div>
        )}
        <div className="cart-row">
          <span>결제 금액</span>
          <b>{won(o.totalAmount)}</b>
        </div>
        {(o.refundAmount ?? 0) > 0 && (
          <div className="cart-row">
            <span>환불 금액</span>
            <span>{won(o.refundAmount!)}</span>
          </div>
        )}
        {o.paymentInfo && (
          <div className="cart-row">
            <span>결제 수단</span>
            <span>{payMethodText(o.paymentInfo)}</span>
          </div>
        )}
        {o.cashReceipt && (
          <div className="cart-row">
            <span>현금영수증 · 세금계산서</span>
            <span>{o.cashReceipt.requested ? "신청했어요" : "신청 안 함"}</span>
          </div>
        )}
        {o.paymentInfo?.method === "CARD" && <p className="cart-hint">카드 결제는 카드 매출전표로 대신해요</p>}
        <p className="cart-hint">주문을 모두 취소하면 쓴 적립금이 바로 돌아와요 · 일부만 환불하면 환불한 비율만큼 돌아와요 · 카드 취소는 3~5영업일 걸려요</p>
      </section>
      {(o.shippingAddress || o.shipment) && (
        <section className="co-box" aria-labelledby="od-addr">
          <h2 id="od-addr">배송 정보</h2>
          <dl className="od-dl">
            {o.shippingAddress && (
              <>
                <div>
                  <dt>받는 분</dt>
                  <dd>
                    {o.shippingAddress.recipientName} · {o.shippingAddress.phone}
                  </dd>
                </div>
                <div>
                  <dt>주소</dt>
                  <dd>
                    {o.shippingAddress.address1}
                    {o.shippingAddress.address2 ? `, ${o.shippingAddress.address2}` : ""} ({o.shippingAddress.zipCode})
                  </dd>
                </div>
                {o.shippingAddress.memo && (
                  <div>
                    <dt>배송 메모</dt>
                    <dd>{o.shippingAddress.memo}</dd>
                  </div>
                )}
                {o.fulfillmentType && (
                  <div>
                    <dt>받는 방법</dt>
                    <dd>{o.fulfillmentType === "STORAGE" ? "보관하기 · 합배송" : `택배 (${won(o.shippingFee)})`}</dd>
                  </div>
                )}
              </>
            )}
            {o.shipment && (
              <>
                <div>
                  <dt>배송 상태</dt>
                  <dd>{SHIP[o.shipment.status]}</dd>
                </div>
                <div>
                  <dt>송장</dt>
                  <dd>
                    {o.shipment.courierName} {o.shipment.trackingNumber}
                  </dd>
                </div>
              </>
            )}
          </dl>
          {o.shipment && trackingUrl(o.shipment.courier, o.shipment.trackingNumber) && (
            <a className="btn btn-sm btn-out" href={trackingUrl(o.shipment.courier, o.shipment.trackingNumber)!} target="_blank" rel="noopener noreferrer">
              송장 조회
            </a>
          )}
        </section>
      )}
      {(o.status === "PAID" || o.status === "REFUNDED") && <RefundRequestSection slug={slug} orderId={o.id} onChanged={() => setTick((t) => t + 1)} />}
      {(o.status === "PAID" || o.status === "REFUNDED") && <ReturnSection slug={slug} orderId={o.id} />}
      <div className="cart-tools">
        <Link className="btn btn-sm btn-out" href={`${base}/orders`}>
          목록
        </Link>
        <Link className="btn btn-sm btn-out" href={`${base}/products`}>
          계속 쇼핑하기
        </Link>
      </div>
    </div>,
    done ? "주문 완료" : "주문 상세",
  );
}
