"use client";

import { formatDateTime, formatTime } from "../../../../../../lib/client/format";
import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { sanitizeNext, useSmartBack } from "../../../../../../lib/client/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import RefundModal from "../../../../../../components/seller/RefundModal";
import { OrderMemo, PrepareShipping } from "../../../../../../components/seller/OrderWork";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { LoadingRows, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { COURIERS, isCourier } from "../../../../../../lib/server/orders/shipping";
import { PAYMENT_METHOD, STATUS_BADGE, detailStatusLabel, historyActor, historyLabel, historyNote, phoneText, type OrderDetail } from "../../../../../../components/seller/orders";

// SA-022 판매자 주문 상세(GET /api/seller/orders/{id}). 결제 완료 주문만 「취소 · 환불」(SA-023 모달)을 열 수 있다.
// 받는 분 이름·연락처·주소는 고객 정보 보기 권한이 있을 때만 서버가 준다(열람 기록은 서버가 남긴다).
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; order: OrderDetail };

const FAULT_LABEL = { BUYER: "구매자 사정", SELLER: "파트너스 사정" } as const;
// 송장의 택배사는 코드(CJ·HANJIN …)로 저장된다. 화면 이름으로 바꾸고, 모르는 값은 그대로 보인다.
const courierName = (c: string) => (isCourier(c) ? COURIERS[c] : "택배사 확인 필요");

// 주문 상품 표 · 알림 발송 표 이름(서버 값 → 화면 이름)
const QUEUE_LABEL = { WAITING: "대기", OPENING: "개봉 중", DONE: "개봉 완료", CANCELLED: "취소" } as const;
const QUEUE_CLS = { WAITING: "b-wait", OPENING: "b-info", DONE: "b-done", CANCELLED: "b-cancel" } as const;
const PROVIDER: Record<string, string> = { nicepay: "나이스페이" };
const PAYMENT_STATUS: Record<string, string> = { READY: "결제 대기", APPROVING: "승인 중", PAID: "결제 완료", FAILED: "결제 실패", CANCELLED: "결제 취소", PARTIAL_CANCELLED: "일부 취소" };
const NOTI_KIND: Record<string, string> = {
  PAYMENT_DUE_SOON: "입금 기한 알림",
  RECEIPT_ISSUED: "영수증 발급 알림",
  SHIPPING_PREPARED: "배송 준비 알림",
  "order.pending_bank": "입금 안내 메일",
  "order.paid": "결제 완료 메일",
  "order.shipped": "발송 안내 메일",
  "order.delivered": "배송 완료 메일",
  "order.refund": "환불 안내 메일",
};
const NOTI_STATUS: Record<string, string> = { PENDING: "대기", SENT: "발송 완료", FAILED: "발송 실패", SKIPPED_BALANCE: "보내지 않음 · 충전금 부족", SKIPPED_PLATFORM_LIMIT: "보내지 않음 · 월 제공량 초과" };

function OrderDetailContent() {
  const query = useSearchParams();
  const safeReturnTo = sanitizeNext(query.get("returnTo"), ["/seller/orders"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/orders" ? safeReturnTo : "/seller/orders";
  const smartBack = useSmartBack(listHref);
  const router = useRouter();
  const { can } = useSeller();
  const back = useCallback(() => safeReturnTo?.split("?")[0] === "/seller/orders" ? router.replace(listHref) : smartBack(), [safeReturnTo, listHref, router, smartBack]);
  const backHandler = useRef<(() => Promise<boolean>) | null>(null);
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
        const params = new URLSearchParams(window.location.search);
        params.delete("refund");
        window.history.replaceState(window.history.state, "", `/seller/orders/${orderId}${params.size ? `?${params}` : ""}`);
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
                <SmartBackButton fallback={listHref} className="btn btn-sm btn-out">주문 목록으로</SmartBackButton>
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
  const hhmm = formatTime(o.createdAt);

  const queued = o.items.map((i) => i.queue).filter((q): q is NonNullable<typeof q> => !!q);
  const session = queued.find((q) => q.broadcastSession)?.broadcastSession ?? null;
  const ahead = queued.find((q) => q.status === "WAITING")?.aheadCount ?? null;
  const payment = o.payments?.find((x) => x.approvedAt) ?? o.payments?.[0];
  const stateText = o.status === "CANCELLED" || o.status === "REFUNDED" ? STATUS_BADGE[o.status].label : o.queueState === "waiting" ? "개봉 대기" : o.queueState === "opening" ? "개봉 중" : o.queueState === "done" ? "개봉 완료" : detailStatusLabel(o.status);
  const paidText = o.status === "PAID" ? "완료" : o.status === "PENDING_PAYMENT" ? "대기" : STATUS_BADGE[o.status].label;
  const method = o.paymentMethod ? PAYMENT_METHOD[o.paymentMethod] : "—";
  const consent = o.consents?.find((c) => c.kind === "OPENED_NO_REFUND");
  const canInvoice = o.status === "PAID" && (!o.shipment || o.shipment.status === "READY");
  const pg = o.pgTxId ?? payment?.pgTid ?? null;
  const provider = o.pgProvider ?? payment?.provider ?? null;

  return (
    <>
      <Topbar crumb={`판매 › 주문 › ${hhmm} ${nick}`} />
      <main className="main">
        <PageHead
          onBack={async () => { if (backHandler.current && !(await backHandler.current())) return; back(); }}
          back={listHref}
          title="주문 상세"
          actions={
            <>
              <Link className="btn btn-out" href={listHref}>
                목록
              </Link>
              {canRefund && (
                <button className="btn btn-out" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setRefundOpen(true)}>
                  취소 · 환불
                </button>
              )}
              {canInvoice && (
                <Link className="btn" href="/seller/shipping">
                  송장 입력
                </Link>
              )}
            </>
          }
        />
        <div className="ord-ono-bar t-l2">
          <span>주문번호</span>
          <b className="num" data-testid="order-no-label">
            {o.orderNoLabel}
          </b>
          <button className="btn btn-dense btn-out btn-w-xs" type="button" onClick={() => void copyOrderNo(o.orderNoLabel)}>
            복사
          </button>
          <span className="t-c1 c-alt">전화 응대 · 검색 대조용 · 목록에서도 접수 시각 아래 보조 표시</span>
        </div>

        <div className="ord-sum" data-testid="order-summary">
          <div>
            <div className="k">구매자</div>
            <div className="v">{nick}</div>
          </div>
          <div>
            <div className="k">접수</div>
            <div className="v num">{formatDateTime(o.createdAt)}</div>
          </div>
          <div data-testid="order-summary-pay">
            <div className="k">결제</div>
            <div className="v num">{won(o.totalAmount)}<small>{method} · {paidText}</small></div>
          </div>
          <div data-testid="order-summary-state">
            <div className="k">주문 상태</div>
            <div className="v">{stateText}{ahead !== null && <small>앞에 {ahead}건 대기</small>}</div>
          </div>
          <div>
            <div className="k">방송</div>
            <div className="v ord-sum-s">{session ? session.title || "제목 없는 방송" : "—"}{session?.startedAt && <small>{new Date(session.startedAt).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" })}</small>}</div>
          </div>
        </div>

        <section aria-label="주문 상품">
        <h2 className="ord-sec-t">주문 상품</h2>
        <div className="au-lt-wrap">
          <table className="tbl" data-testid="order-items">
            <thead>
              <tr>
                <th style={{ width: 88 }}>이미지</th>
                <th className="col-text" style={{ textAlign: "left" }}>상품</th>
                <th style={{ width: 120 }}>옵션</th>
                <th style={{ width: 60 }}>수량</th>
                <th style={{ width: 110 }}>판매가</th>
                <th style={{ width: 80 }}>주문대기</th>
                <th style={{ width: 90 }}>상태</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.imageUrl ? <img className="ord-thumb" src={i.imageUrl} alt="" /> : <span className="ord-thumb ord-thumb-none" />}</td>
                  <td className="col-text">{i.productId && can("PRODUCT_MANAGE") ? <Link className="ord-link" href={`/seller/products/${i.productId}`}>{i.productNameSnapshot}</Link> : i.productNameSnapshot}</td>
                  <td>{i.optionNameSnapshot}</td>
                  <td className="num">{i.quantity}</td>
                  <td className="num" style={{ textAlign: "right" }}>{won(i.unitPrice)}</td>
                  <td>{i.queue ? <span className="bdg b-info nodot">대상</span> : "—"}</td>
                  <td>{i.queue ? <span className={`bdg ${QUEUE_CLS[i.queue.status]}`}>{QUEUE_LABEL[i.queue.status]}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <table className="au-ft ord-ft4">
          <tbody>
            <tr>
              <th>상품 금액</th>
              <td className="num">{won(itemsAmount)}</td>
              <th>적립금 사용</th>
              <td className="num">{o.rewardUsedAmount > 0 ? `−${won(o.rewardUsedAmount)}` : "0원"}</td>
            </tr>
            <tr>
              <th>배송비</th>
              <td className="num">{won(o.shippingFee)}</td>
              <th>결제 금액</th>
              <td className="num fw7">{won(o.totalAmount)}</td>
            </tr>
            <tr>
              <th>적립 예정</th>
              <td>
                {o.rewardEarnAmount ? (
                  <>
                    <span className="num">+{won(o.rewardEarnAmount)}</span>
                    {o.rewardRate ? ` (${Number(o.rewardRate.toFixed(2))}%)` : ""} · {o.rewardEarnTiming === "ON_PAYMENT" ? "결제하면 바로 지급" : "배송 완료 후 지급"}
                  </>
                ) : (
                  "없음"
                )}
              </td>
              <th>쿠폰</th>
              <td>{o.couponRedemption ? <>{o.couponRedemption.coupon.name} · <span className="num c-neg">−{won(o.couponRedemption.discountAmount)}</span></> : "사용 안 함"}</td>
            </tr>
          </tbody>
        </table>

        </section>

        <h2 className="ord-sec-t">결제 정보</h2>
        <table className="au-ft ord-ft4">
          <tbody>
            <tr>
              <th>결제 수단</th>
              <td>
                {method}
                {payment?.method === "CARD" && payment.cardName && ` (${payment.cardName}${payment.cardLast4 ? ` ****-${payment.cardLast4}` : ""}) · ${payment.cardInstallment && payment.cardInstallment > 1 ? `${payment.cardInstallment}개월 할부` : "일시불"}`}
              </td>
              <th>결제 시각</th>
              <td className="num">{o.paidAt ? formatDateTime(o.paidAt) : "아직 결제하지 않았습니다"}</td>
            </tr>
            <tr>
              <th>PG 거래 ID</th>
              <td className="num">{pg ?? "—"}</td>
              <th>결제대행사</th>
              <td>{provider ? `${PROVIDER[provider] ?? provider}${payment ? ` · ${PAYMENT_STATUS[payment.status] ?? payment.status}` : ""}` : "—"}</td>
            </tr>
            <tr>
              <th>개봉 상품 고지 동의</th>
              <td>{consent ? <>동의함 · <span className="num">{formatDateTime(consent.agreedAt)}</span> · 결제 전 확인</> : "기록 없음"}</td>
              <th>환불</th>
              <td>
                {o.status === "REFUNDED" ? (
                  <>
                    <span className="num">{won(o.refundAmount ?? o.totalAmount)}</span>
                    {o.refundedAt && <> · <span className="num">{formatDateTime(o.refundedAt)}</span></>}
                    {o.refundFault && ` · ${FAULT_LABEL[o.refundFault]}`}
                    {!!o.returnFeeDeducted && <> · 뺀 반품 배송비 <span className="num">{won(o.returnFeeDeducted)}</span></>}
                  </>
                ) : o.status === "CANCELLED" && o.cancelledAt ? (
                  <>취소 · <span className="num">{formatDateTime(o.cancelledAt)}</span></>
                ) : (
                  "환불 없음"
                )}
              </td>
            </tr>
            <tr>
              <th>현금영수증 · 세금계산서</th>
              <td>
                {can("RECEIPT_TAX") ? (
                  <Link className="btn btn-sm btn-out" href="/seller/orders/receipts">
                    발행 관리
                  </Link>
                ) : (
                  "—"
                )}
              </td>
              <th>주문번호</th>
              <td className="c-alt num">{o.orderNoLabel} · 상단과 같음</td>
            </tr>
          </tbody>
        </table>

        <h2 className="ord-sec-t">구매자 · 배송</h2>
        <table className="au-ft ord-ft4">
          <tbody>
            <tr>
              <th>방송 닉네임</th>
              <td className="fw6">{nick}</td>
              <th>회원</th>
              <td>
                {can("MEMBER_POINTS") ? (
                  <Link className="ord-link" href={`/seller/members/${o.buyer.id}`}>
                    {nick}
                  </Link>
                ) : (
                  nick
                )}
              </td>
            </tr>
            <tr>
              <th>받는 분</th>
              <td>{addr?.recipientName !== undefined ? <>{addr.recipientName} · <span className="num">{addr.phone && phoneText(addr.phone)}</span></> : "개인정보 열람 권한 필요"}</td>
              <th>배송지</th>
              <td>{addr?.recipientName !== undefined ? `(${addr.zipCode}) ${addr.address1} ${addr.address2 ?? ""}` : "개인정보 열람 권한 필요"}{addr?.isRemote && <span className="c-alt"> · 섬·산간 지역이라 추가 배송비가 붙습니다</span>}</td>
            </tr>
            <tr>
              <th>배송 메모</th>
              <td>{addr?.memo || "—"}</td>
              <th>송장</th>
              <td>
                {o.shipment ? <>{courierName(o.shipment.courier)} <span className="num">{o.shipment.trackingNumber}</span> · 발송 <span className="num">{formatDateTime(o.shipment.shippedAt)}</span></> : "아직 보내지 않았습니다"}
              </td>
            </tr>
          </tbody>
        </table>
        {pii ? (
          <span className="hint">연락처 · 주소 열람은 로그 추적에 남습니다</span>
        ) : (
          <span className="hint">개인정보를 볼 수 있는 사람이 아니어서 닉네임과 주문 내용만 보입니다. 필요하면 대표자에게 허용을 요청해 주십시오.</span>
        )}

        <section className="card pad col" style={{ gap: 8, marginTop: 16 }} id="order-preparation" aria-label="배송 준비">
          <h2 className="t-hl2">배송 준비</h2>
          {o.shippingPreparedAt ? <p>배송 준비로 변경했습니다.</p> : <PrepareShipping ids={[o.id]} disabled={o.status !== "PAID" || !!(o.shipment && o.shipment.status !== "READY") || o.queueState !== "done"} onDone={() => void load()} />}
        </section>

        <h2 className="ord-sec-t">HIT 기록</h2>
        <table className="au-ft" data-testid="order-hit">
          <tbody>
            {(o.hitCards ?? []).length === 0 ? (
              <tr>
                <th>HIT 카드</th>
                <td className="c-alt">기록이 없습니다</td>
              </tr>
            ) : (
              (o.hitCards ?? []).map((h) => (
                <tr key={h.id}>
                  <th>HIT 카드</th>
                  <td>
                    {h.cardName} · <span className="num">{formatTime(h.createdAt)}</span> 등록 {h.grade && <>· {h.grade} </>}
                    <span className="bdg b-wait nodot">HIT</span>
                    {h.note && <span className="c-alt"> · {h.note}</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <OrderMemo key={o.id} backHandler={backHandler} orderId={o.id} orderNoLabel={o.orderNoLabel} />

        <div className="ord-two">
          <div data-testid="order-history">
            <h2 className="ord-sec-t">상태 이력<span className="nt"> 시각 순 · 상태 변경 · 결제 승인 · 일부 환불 · 결제 취소 · 처리는 역할·이름만</span></h2>
            <div>
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
                        <td className="num">{formatDateTime(e.at)}</td>
                        <td>{historyLabel(e)}</td>
                        <td>{historyActor(e.actor)}</td>
                        <td>{historyNote(e)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          </div>
          <div>
            <h2 className="ord-sec-t">알림 발송</h2>
            <div className="ord-hist-scroll" data-testid="order-notifications">
              <table className="tbl ord-hist-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>시각</th>
                    <th>알림</th>
                    <th style={{ width: 90 }}>방식</th>
                    <th className="l">결과</th>
                  </tr>
                </thead>
                <tbody>
                  {(o.notifications ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={4} className="c-alt">보낸 알림이 없습니다</td>
                    </tr>
                  ) : (
                    (o.notifications ?? []).map((n) => (
                      <tr key={n.id}>
                        <td className="num">{formatDateTime(n.sentAt ?? n.createdAt)}</td>
                        <td>{NOTI_KIND[n.kind] ?? n.kind}</td>
                        <td>{n.source === "MAIL_DELIVERY" ? "메일" : "알림"}</td>
                        <td>{NOTI_STATUS[n.status] ?? "확인 필요"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
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

export default function OrderDetailPage() { return <Suspense><OrderDetailContent /></Suspense>; }
