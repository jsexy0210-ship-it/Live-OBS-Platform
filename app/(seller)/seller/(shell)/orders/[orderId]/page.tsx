"use client";

import "../../../../../../styles/seller-orders.css";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import RefundModal from "../../../../../../components/seller/RefundModal";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { LoadingRows, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { COURIERS, isCourier } from "../../../../../../lib/server/orders/shipping";
import { PAYMENT_METHOD, STATUS_BADGE, detailStatusLabel, fullTime, historyActor, historyLabel, historyNote, longTime, phoneText, type OrderDetail } from "../../../../../../components/seller/orders";

// SA-022 판매자 주문 상세(GET /api/seller/orders/{id}). 결제 완료 주문만 「취소 · 환불」(SA-023 모달)을 열 수 있다.
// 받는 분 이름·연락처·주소는 고객 정보 보기 권한이 있을 때만 서버가 준다(열람 기록은 서버가 남긴다).
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; order: OrderDetail };

const SHIPMENT_STATUS: Record<string, string> = { IN_TRANSIT: "배송 중", DELIVERED: "배송 완료" };
const FAULT_LABEL = { BUYER: "구매자 사정", SELLER: "파트너스 사정" } as const;
// 송장의 택배사는 코드(CJ·HANJIN …)로 저장된다. 화면 이름으로 바꾸고, 모르는 값은 그대로 보인다.
const courierName = (c: string) => (isCourier(c) ? COURIERS[c] : c);

export default function OrderDetailPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [refundOpen, setRefundOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<OrderDetail>(`/api/seller/orders/${encodeURIComponent(orderId)}`);
    setState(r.ok ? { kind: "ok", order: r.data } : { kind: "error", status: r.status });
    return r;
  }, [orderId]);

  useEffect(() => {
    void (async () => {
      const r = await load();
      // 목록의 「환불 처리」로 들어오면 바로 환불 창을 연다(환불할 수 있는 주문일 때만)
      if (new URLSearchParams(window.location.search).get("refund") === "1") {
        window.history.replaceState(null, "", `/seller/orders/${orderId}`);
        if (r.ok && r.data.status === "PAID") setRefundOpen(true);
      }
    })();
  }, [load, orderId]);

  const copyOrderNo = async (label: string) => {
    try {
      await navigator.clipboard.writeText(label);
      setToast({ text: "주문번호를 복사했습니다" });
    } catch {
      setToast({ text: "복사하지 못했습니다. 주문번호를 직접 선택해 주십시오", neg: true });
    }
  };

  if (state.kind !== "ok") {
    return (
      <>
        <Topbar crumb="판매 › 주문" />
        <main className="main">
          <div className="card">
            {state.kind === "loading" ? (
              <LoadingRows rows={4} />
            ) : state.status === 403 ? (
              <NoPermission need="주문·배송" />
            ) : state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <div className="st-ic neg">!</div>
                <span className="t">주문을 찾을 수 없습니다</span>
                <span className="s">삭제되었거나 다른 쇼핑몰의 주문입니다.</span>
                <SmartBackButton fallback="/seller/orders" className="btn btn-sm btn-out">주문 목록으로</SmartBackButton>
              </div>
            ) : (
              <div className="st" style={{ boxShadow: "none" }}>
                <div className="st-ic neg">!</div>
                <span className="t">주문을 불러오지 못했습니다</span>
                <button className="btn btn-sm" type="button" onClick={() => void load()}>
                  다시 시도
                </button>
              </div>
            )}
          </div>
        </main>
      </>
    );
  }

  const o = state.order;
  const nick = o.buyer.broadcastNickname;
  const itemsAmount = o.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const canRefund = o.status === "PAID";
  const pii = o.buyer.name !== undefined;
  const addr = o.shippingAddress;
  const hhmm = longTime(o.createdAt).split(" ").pop();

  return (
    <>
      <Topbar crumb={`판매 › 주문 › ${hhmm} ${nick}`}>
        {canRefund && (
          <button className="btn btn-sm btn-out" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setRefundOpen(true)}>
            취소 · 환불
          </button>
        )}
      </Topbar>
      <main className="main">
        <PageHead
          title={
            <>
              {nick} · {longTime(o.createdAt)} 주문{" "}
              <span className={`bdg bdg-lg ${STATUS_BADGE[o.status].cls}`}>{detailStatusLabel(o.status)}</span>
              {o.shipment && <span className="bdg bdg-lg b-info nodot">{SHIPMENT_STATUS[o.shipment.status] ?? "발송함"}</span>}
            </>
          }
        />
        <div className="col" style={{ gap: 4, marginBottom: 16 }}>
          <span className="t-l2 c-alt">{fullTime(o.createdAt)} 접수</span>
          <div className="ord-ono-bar t-l2">
            <span>주문번호</span>
            <b className="num" data-testid="order-no-label">
              {o.orderNoLabel}
            </b>
            <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => void copyOrderNo(o.orderNoLabel)}>
              복사
            </button>
            <span className="t-c1 c-alt">전화 응대 · 검색 대조용</span>
          </div>
        </div>

        <div className="ord-detail">
          <div className="col" style={{ gap: 20 }}>
            <section className="card pad col" style={{ gap: 12 }}>
              <h2 className="t-hl2">주문 상품</h2>
              {o.items.map((i) => (
                <div key={i.id} className="row" style={{ gap: 12 }}>
                  <div className="col grow">
                    <span className="t-l1 fw6">{i.productNameSnapshot}</span>
                    <span className="t-c1 c-alt">
                      옵션 {i.optionNameSnapshot} · 수량 {i.quantity}
                    </span>
                  </div>
                  <span className="t-l1 num fw6">{won(i.unitPrice * i.quantity)}</span>
                </div>
              ))}
              <hr className="divider" />
              <dl className="kv">
                <dt>상품 금액</dt>
                <dd className="num">{won(itemsAmount)}</dd>
                {o.shippingFee > 0 && (
                  <>
                    <dt>배송비</dt>
                    <dd className="num">{won(o.shippingFee)}</dd>
                  </>
                )}
                {o.couponRedemption && (
                  <>
                    <dt>쿠폰 할인 · {o.couponRedemption.coupon.name}</dt>
                    <dd className="num c-neg">−{won(o.couponRedemption.discountAmount)}</dd>
                  </>
                )}
                {o.rewardUsedAmount > 0 && (
                  <>
                    <dt>적립금 사용</dt>
                    <dd className="num c-neg">−{won(o.rewardUsedAmount)}</dd>
                  </>
                )}
                <dt>결제 금액</dt>
                <dd className="num fw7">{won(o.totalAmount)}</dd>
              </dl>
            </section>
            <section className="card pad col" style={{ gap: 12 }}>
              <h2 className="t-hl2">결제 정보</h2>
              <dl className="kv">
                <dt>결제 수단</dt>
                <dd>{o.paymentMethod ? PAYMENT_METHOD[o.paymentMethod] : "—"}</dd>
                <dt>결제 시각</dt>
                <dd className="num">{o.paidAt ? fullTime(o.paidAt) : "아직 결제하지 않았습니다"}</dd>
                {o.status === "REFUNDED" && (
                  <>
                    <dt>환불</dt>
                    <dd className="num">
                      {won(o.refundAmount ?? o.totalAmount)}
                      {o.refundedAt && ` · ${fullTime(o.refundedAt)}`}
                    </dd>
                    {o.refundFault && (
                      <>
                        <dt>사유 주체</dt>
                        <dd>{FAULT_LABEL[o.refundFault]}</dd>
                      </>
                    )}
                    {!!o.returnFeeDeducted && (
                      <>
                        <dt>뺀 반품 배송비</dt>
                        <dd className="num">{won(o.returnFeeDeducted)}</dd>
                      </>
                    )}
                  </>
                )}
                {o.status === "CANCELLED" && o.cancelledAt && (
                  <>
                    <dt>취소</dt>
                    <dd className="num">{fullTime(o.cancelledAt)}</dd>
                  </>
                )}
              </dl>
            </section>
          </div>

          <div className="col" style={{ gap: 20 }}>
            <section className="card pad col" style={{ gap: 12 }}>
              <h2 className="t-hl2">구매자</h2>
              <dl className="kv">
                <dt>방송 닉네임</dt>
                <dd className="fw6">{nick}</dd>
                <dt>회원</dt>
                <dd>{nick}</dd>
              </dl>
              {!pii && <span className="t-c1 c-alt">닉네임과 주문 내용만 표시됩니다</span>}
            </section>
            <section className="card pad col" style={{ gap: 12 }}>
              <h2 className="t-hl2">배송</h2>
              <dl className="kv">
                {addr?.recipientName !== undefined && (
                  <>
                    <dt>받는 분</dt>
                    <dd>
                      {addr.recipientName} · <span className="num">{addr.phone && phoneText(addr.phone)}</span>
                    </dd>
                    <dt>배송지</dt>
                    <dd>
                      ({addr.zipCode}) {addr.address1} {addr.address2 ?? ""}
                    </dd>
                    {addr.memo && (
                      <>
                        <dt>배송 메모</dt>
                        <dd>{addr.memo}</dd>
                      </>
                    )}
                  </>
                )}
                {addr?.isRemote && (
                  <>
                    <dt>도서산간</dt>
                    <dd>추가 배송비 지역입니다</dd>
                  </>
                )}
                <dt>송장</dt>
                <dd>{o.shipment ? `${courierName(o.shipment.courier)} ${o.shipment.trackingNumber}` : "아직 보내지 않았습니다"}</dd>
                {o.shipment && (
                  <>
                    <dt>발송 시각</dt>
                    <dd className="num">{fullTime(o.shipment.shippedAt)}</dd>
                  </>
                )}
              </dl>
              {pii && <span className="t-c1 c-alt">연락처·주소는 열람 시 열람 기록이 남습니다.</span>}
            </section>
          </div>
        </div>
        {/* SA-022 하단 2열: 왼쪽 상태 이력(오른쪽 알림 발송은 서버 계약이 생기면 추가) */}
        <div className="ord-detail ord-history">
          <section className="card pad col" style={{ gap: 12 }} data-testid="order-history">
            <h2 className="t-hl2">상태 이력</h2>
            {o.history.length === 0 ? (
              <span className="t-c1 c-alt">아직 이력이 없습니다</span>
            ) : (
              <div className="ord-hist-scroll"><table className="tbl ord-hist-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>시각</th>
                    <th>상태</th>
                    <th style={{ width: 110 }}>처리</th>
                    <th className="l">비고</th>
                  </tr>
                </thead>
                <tbody>
                  {[...o.history].reverse().map((e, i) => (
                    <tr key={i} data-testid="history-row">
                      <td className="num">{fullTime(e.at)}</td>
                      <td>{historyLabel(e)}</td>
                      <td>{historyActor(e.actor)}</td>
                      <td>{historyNote(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>
        </div>
      </main>
      {refundOpen && (
        <RefundModal
          order={o}
          onClose={() => setRefundOpen(false)}
          onDone={(amount) => {
            setRefundOpen(false);
            setToast({ text: `${won(amount)} 환불을 완료했습니다` });
            void load();
          }}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
