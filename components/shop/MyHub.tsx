"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { call } from "./reviewShared";
import { formatDate, formatDateTimeParts } from "../../lib/client/format";
import "./MyHub.css";

// SH-020 내 정보 허브 본문(보드 SH-020-IA 휴대폰 · SH-020-PC-IA): 요약 칸(기다리는 주문 · 적립금 · 쿠폰 · 등급)과 PC의 「최근 주문」 표.
// 값은 모두 기존 서버 값이다(주문 목록 · 적립금 · 쿠폰함). 보드의 「내 차례」 띠·메일 표시·소멸 예정 외 문의 답변 수는 서버 값이 없어 그리지 않는다(docs/UI_STATUS.md).
type Order = {
  id: string;
  orderNoLabel: string;
  status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";
  totalAmount: number;
  createdAt: string;
  queue: { status: "WAITING" | "OPENING" | "DONE"; aheadCount: number } | null;
  items: { productNameSnapshot: string; optionNameSnapshot: string; quantity: number }[];
  shipment: { status: "READY" | "IN_TRANSIT" | "DELIVERED" } | null;
};
type Orders = { orders: Order[]; counts: { inProgress: number } };
type Rewards = { balance: number; expiringSoon: { amount: number; expiresAt: string } | null };
type Coupons = { usable: { state: string; expiresAt: string }[] };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const RECENT = 5;

// 주문 목록 화면(OrdersView)과 같은 상태 문구
function stateOf(o: Order): { label: string; tone: string; sub?: string } {
  if (o.status === "PENDING_PAYMENT") return { label: "결제 전", tone: "y" };
  if (o.status === "CANCELLED") return { label: "취소했어요", tone: "g" };
  if (o.status === "REFUNDED") return { label: "환불했어요", tone: "g" };
  if (o.shipment?.status === "DELIVERED") return { label: "배송 완료", tone: "gr" };
  if (o.shipment?.status === "IN_TRANSIT") return { label: "배송 중", tone: "bl" };
  if (!o.shipment && o.queue?.status === "WAITING") return { label: "개봉 대기", tone: "bl", sub: `앞에 ${o.queue.aheadCount}명` };
  if (!o.shipment && o.queue?.status === "OPENING") return { label: "개봉 중", tone: "bl" };
  return { label: o.shipment ? "배송 준비 중" : "결제 완료", tone: "bl" };
}

export default function MyHub({ slug, grade }: { slug: string; grade: { name: string; sub: string } | null }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}`;
  const [orders, setOrders] = useState<Orders | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [coupons, setCoupons] = useState<Coupons | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([call<Orders>(`${api}/orders?limit=20`), call<Rewards>(`${api}/me/rewards`), call<Coupons>(`${api}/coupons`)]).then(([o, r, c]) => {
      if (!live) return;
      if (o.ok) setOrders(o.data);
      if (r.ok) setRewards(r.data);
      if (c.ok) setCoupons(c.data);
      setFailed(!o.ok || !r.ok || !c.ok);
    });
    return () => {
      live = false;
    };
  }, [api]);

  const waiting = orders?.orders.filter((o) => !o.shipment && o.queue?.status === "WAITING") ?? [];
  const ahead = waiting.length ? Math.min(...waiting.map((o) => o.queue!.aheadCount)) : null;
  const usable = coupons?.usable.filter((c) => c.state === "usable") ?? [];
  const soonest = usable.length ? usable.map((c) => c.expiresAt).sort()[0] : null;
  const soonestN = soonest ? usable.filter((c) => c.expiresAt.slice(0, 10) === soonest.slice(0, 10)).length : 0;
  const recent = orders?.orders.slice(0, RECENT) ?? [];
  const dash = "–";

  return (
    <div className="hub">
      <div className="hub-stats" aria-label="내 요약">
        <Link className="hub-stat" href={`${base}/orders`}>
          <span className="hub-k">기다리는 주문</span>
          <b className="hub-v">{orders ? `${waiting.length}건` : dash}</b>
          <span className="hub-s">{orders ? (ahead !== null ? `앞에 ${ahead}명` : orders.counts.inProgress ? `진행 중 ${orders.counts.inProgress}건` : "기다리는 주문이 없어요") : ""}</span>
        </Link>
        <Link className="hub-stat" href={`${base}/me/rewards`}>
          <span className="hub-k">적립금</span>
          <b className="hub-v">{rewards ? won(rewards.balance) : dash}</b>
          <span className="hub-s">{rewards?.expiringSoon ? `${formatDate(rewards.expiringSoon.expiresAt)} 소멸 예정 ${won(rewards.expiringSoon.amount)}` : ""}</span>
        </Link>
        <Link className="hub-stat" href={`${base}/coupons`}>
          <span className="hub-k">쿠폰</span>
          <b className="hub-v">{coupons ? `${usable.length}장` : dash}</b>
          <span className="hub-s">{soonest ? `${formatDate(soonest)}까지 ${soonestN}장` : ""}</span>
        </Link>
        {grade && (
          <div className="hub-stat hub-grade">
            <span className="hub-k">회원 등급</span>
            <b className="hub-v">{grade.name}</b>
            <span className="hub-s">{grade.sub}</span>
          </div>
        )}
      </div>
      {failed && (
        <p className="msg msg-neg t-l2" role="alert">
          일부 정보를 불러오지 못했어요. 새로고침해 주세요.
        </p>
      )}
      <section className="hub-recent" aria-labelledby="hub-recent-h">
        <div className="hub-recent-head">
          <h2 id="hub-recent-h">최근 주문</h2>
          <Link href={`${base}/orders`}>더 보기 ›</Link>
        </div>
        {orders && recent.length === 0 ? (
          <p className="hub-empty">아직 주문이 없어요</p>
        ) : (
          <table className="hub-tbl">
            <thead>
              <tr>
                <th scope="col">주문일 · 번호</th>
                <th scope="col">상품 정보</th>
                <th scope="col" className="r">
                  금액
                </th>
                <th scope="col">상태</th>
                <th scope="col">관리</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((o) => {
                const st = stateOf(o);
                const when = formatDateTimeParts(o.createdAt);
                const first = o.items[0];
                return (
                  <tr key={o.id}>
                    <td>
                      <span className="hub-when">{when?.date}</span>
                      <span className="hub-time">{when?.time}</span>
                      <Link className="hub-no" href={`${base}/orders/${o.id}`}>
                        {o.orderNoLabel}
                      </Link>
                    </td>
                    <td>
                      <b className="hub-name">
                        {first?.productNameSnapshot}
                        {o.items.length > 1 ? ` 외 ${o.items.length - 1}건` : ""}
                      </b>
                      {first && (
                        <span className="hub-opt">
                          {first.optionNameSnapshot} × {first.quantity}
                        </span>
                      )}
                    </td>
                    <td className="r">{won(o.totalAmount)}</td>
                    <td>
                      <span className={`hub-st hub-st-${st.tone}`}>{st.label}</span>
                      {st.sub && <span className="hub-opt">{st.sub}</span>}
                    </td>
                    <td>
                      <Link className="btn btn-out btn-sm" href={`${base}/orders/${o.id}`}>
                        주문 상세
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
