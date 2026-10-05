"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import MyMenu from "./MyMenu";
import { call } from "./reviewShared";
import { trackingUrl } from "./trackingLink";
import { qtyText } from "./orderFormat";
import "./Cart.css";
import "./MyMenu.css";
import "./Orders.css";

// SH-021 주문 내역(시안 04 SH). 본인 주문 목록 API(/api/shop/{slug}/orders, 최신순·cursor)로 읽는다. 상태 탭은 불러온 주문 안에서 거른다.
// 기간 조회·주문 취소 요청은 해당 API가 생기면 붙인다.
type Order = {
  id: string;
  orderNo: number;
  status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";
  totalAmount: number;
  createdAt: string;
  refundedAt: string | null;
  paymentDueAt: string | null;
  items: { productNameSnapshot: string; optionNameSnapshot: string; unitPrice: number; quantity: number }[];
  shipment: { courier: string; courierName: string; trackingNumber: string; status: "READY" | "IN_TRANSIT" | "DELIVERED" } | null;
};
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; orders: Order[]; next: string | null };
type Tab = "all" | "pending" | "doing" | "done" | "cancel";

const PAGE = 20;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const kst = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "pending", label: "결제 전" },
  { key: "doing", label: "진행 중" },
  { key: "done", label: "완료" },
  { key: "cancel", label: "취소 · 환불" },
];

function tabOf(o: Order): Exclude<Tab, "all"> {
  if (o.status === "PENDING_PAYMENT") return "pending";
  if (o.status === "CANCELLED" || o.status === "REFUNDED") return "cancel";
  return o.shipment?.status === "DELIVERED" ? "done" : "doing";
}
function stateOf(o: Order): { label: string; tone: string } {
  if (o.status === "PENDING_PAYMENT") return { label: "결제 전", tone: "y" };
  if (o.status === "CANCELLED") return { label: "취소했어요", tone: "g" };
  if (o.status === "REFUNDED") return { label: "환불했어요", tone: "g" };
  if (o.shipment?.status === "DELIVERED") return { label: "배송 완료", tone: "gr" };
  if (o.shipment?.status === "IN_TRANSIT") return { label: "배송 중", tone: "bl" };
  return { label: o.shipment ? "배송 준비 중" : "결제 완료", tone: "bl" };
}

export default function OrdersView({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/orders`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("all");
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    const r = await call<{ orders: Order[]; nextCursor: string | null }>(`${api}?limit=${PAGE}`);
    setView(r.ok ? { kind: "ok", orders: r.data.orders, next: r.data.nextCursor } : { kind: r.status === 401 ? "login" : "error" });
  }, [api]);
  useEffect(() => void load(), [load]);

  async function loadMore() {
    if (view.kind !== "ok" || !view.next || more) return;
    setMore(true);
    setMoreError(false);
    const r = await call<{ orders: Order[]; nextCursor: string | null }>(`${api}?limit=${PAGE}&cursor=${encodeURIComponent(view.next)}`);
    if (r.ok) setView({ kind: "ok", orders: [...view.orders, ...r.data.orders], next: r.data.nextCursor });
    else setMoreError(true);
    setMore(false);
  }

  const orders = view.kind === "ok" ? view.orders : [];
  const shown = tab === "all" ? orders : orders.filter((o) => tabOf(o) === tab);
  const count = (t: Tab) => (t === "all" ? orders.length : orders.filter((o) => tabOf(o) === t).length);

  const body =
    view.kind === "loading" ? (
      <p className="shop-empty" aria-busy="true">
        주문 내역을 불러오고 있어요
      </p>
    ) : view.kind === "login" ? (
      <div className="cart-empty">
        <p>로그인하면 주문 내역을 볼 수 있어요.</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/orders`)}`}>
          로그인
        </Link>
      </div>
    ) : view.kind === "error" ? (
      <div className="cart-empty">
        <p>주문 내역을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    ) : orders.length === 0 ? (
      <div className="cart-empty">
        <h2>아직 주문이 없어요</h2>
        <p>마음에 드는 상품을 담아 첫 주문을 해 보세요.</p>
        <Link className="btn" href={`${base}/products`}>
          상품 보러 가기
        </Link>
      </div>
    ) : (
      <>
        <div className="ol-tabs" role="tablist" aria-label="주문 상태">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label} <span>{count(t.key)}</span>
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="shop-empty">{view.next ? "불러온 주문 중에는 없어요. 더 불러와 보세요." : "이 상태의 주문이 없어요."}</p>
        ) : (
          <table className="ol-tbl" aria-label="주문 내역">
            <thead>
              <tr>
                <th>주문일 · 번호</th>
                <th>상품 정보</th>
                <th>상태</th>
                <th>관리</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => {
                const s = stateOf(o);
                const track = o.shipment ? trackingUrl(o.shipment.courier, o.shipment.trackingNumber) : null;
                return (
                  <tr key={o.id}>
                    <td className="ol-date" data-label="주문일 · 번호">
                      <b>{kst(o.createdAt)}</b>
                      <Link href={`${base}/orders/${o.id}`}>{o.orderNo}</Link>
                    </td>
                    <td className="ol-items" data-label="상품 정보">
                      <ul>
                        {o.items.map((i, n) => (
                          <li key={n}>
                            <div>
                              <b>{i.productNameSnapshot}</b>
                              <span className="cart-opt">
                                {qtyText(i.optionNameSnapshot, i.quantity)}
                              </span>
                            </div>
                            <b>{won(i.unitPrice * i.quantity)}</b>
                          </li>
                        ))}
                      </ul>
                      <p className="ol-total">결제 금액 {won(o.totalAmount)}</p>
                    </td>
                    <td className="ol-state" data-label="상태">
                      <span className={`ol-tag ol-${s.tone}`}>{s.label}</span>
                      {o.status === "PENDING_PAYMENT" && o.paymentDueAt && <span className="cart-opt">{kst(o.paymentDueAt)}까지 결제</span>}
                      {o.shipment && o.status === "PAID" && (
                        <span className="cart-opt">
                          {o.shipment.courierName} · {o.shipment.trackingNumber}
                        </span>
                      )}
                    </td>
                    <td className="ol-act" data-label="관리">
                      {o.status === "PENDING_PAYMENT" && (
                        <Link className="btn btn-sm" href={`${base}/orders/${o.id}`}>
                          결제하기
                        </Link>
                      )}
                      {track && (
                        <a className="btn btn-sm btn-out" href={track} target="_blank" rel="noopener noreferrer">
                          배송 조회
                        </a>
                      )}
                      <Link className="btn btn-sm btn-out" href={`${base}/orders/${o.id}`}>
                        상세 보기
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {view.next && (
          <div className="cart-tools" style={{ justifyContent: "center" }}>
            <button className="btn btn-out" type="button" disabled={more} aria-busy={more} onClick={() => void loadMore()}>
              {more ? "불러오고 있어요" : "더 보기"}
            </button>
          </div>
        )}
        {moreError && (
          <p className="cart-msg is-err" role="alert">
            더 불러오지 못했어요. 잠시 뒤 다시 해 주세요
          </p>
        )}
      </>
    );

  return (
    <div className="shop-wrap cart-wrap">
      <div className="cart-head">
        <h1>주문 내역</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div>{body}</div>
      </div>
    </div>
  );
}
