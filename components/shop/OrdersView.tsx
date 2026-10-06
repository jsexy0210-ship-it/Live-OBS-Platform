"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "../../lib/client/format";
import MyMenu from "./MyMenu";
import { call } from "./reviewShared";
import { trackingUrl } from "./trackingLink";
import { qtyText } from "./orderFormat";
import "./Cart.css";
import "./MyMenu.css";
import "./Orders.css";

// SH-021 주문 내역(보드 SH-021-IA). 본인 주문 목록 API(/api/shop/{slug}/orders?tab&from&to&cursor&limit)로 읽는다.
// 상태 탭·기간·탭별 개수(counts)·품목 사진·개봉 대기(queue: 상태·앞 대기 수)는 모두 서버 값이다(#717). 기간은 3개월·6개월·1년(직접 고르기는 날짜 선택 부품 뒤).
type Queue = { status: "WAITING" | "OPENING" | "DONE"; aheadCount: number } | null;
type Order = {
  id: string;
  orderNo: number;
  orderNoLabel: string;
  status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED";
  totalAmount: number;
  createdAt: string;
  refundedAt: string | null;
  paymentDueAt: string | null;
  queue: Queue;
  items: { productNameSnapshot: string; optionNameSnapshot: string; unitPrice: number; quantity: number; imageUrl: string | null; optionId: string | null }[];
  shipment: { courier: string; courierName: string; trackingNumber: string; status: "READY" | "IN_TRANSIT" | "DELIVERED" } | null;
};
type Tab = "all" | "pending" | "inProgress" | "done" | "cancelled" | "refunded";
type Counts = Record<Tab, number>;
type Period = "3m" | "6m" | "1y";
type Data = { orders: Order[]; next: string | null; counts: Counts };
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok" } & Data;

const PAGE = 20;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "pending", label: "결제 전" },
  { key: "inProgress", label: "진행 중" },
  { key: "done", label: "완료" },
  { key: "cancelled", label: "취소" },
  { key: "refunded", label: "환불" },
];
const PERIODS: { key: Period; label: string }[] = [
  { key: "3m", label: "3개월" },
  { key: "6m", label: "6개월" },
  { key: "1y", label: "1년" },
];

// 기간 조건(KST 날짜, 오늘 포함). 3개월·6개월은 같은 날짜의 달 전, 1년은 오늘 포함 365일(서버 최대 366일 안)
function range(p: Period, now = new Date()) {
  const to = new Date(now.getTime() + 9 * 3600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date(to);
  if (p === "1y") from.setUTCDate(from.getUTCDate() - 364);
  else {
    const n = p === "3m" ? 3 : 6;
    const day = to.getUTCDate();
    from.setUTCDate(1);
    from.setUTCMonth(from.getUTCMonth() - n);
    from.setUTCDate(Math.min(day, new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate()));
  }
  return { from: iso(from), to: iso(to) };
}

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

export default function OrdersView({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/orders`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("all");
  const [period, setPeriod] = useState<Period>("3m");
  const [more, setMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const query = useCallback(
    (cursor?: string) => {
      const r = range(period);
      return `${api}?limit=${PAGE}&tab=${tab}&from=${r.from}&to=${r.to}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    },
    [api, tab, period],
  );

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    setMoreError(false);
    const r = await call<{ orders: Order[]; nextCursor: string | null; counts: Counts }>(query());
    setView(r.ok ? { kind: "ok", orders: r.data.orders, next: r.data.nextCursor, counts: r.data.counts } : { kind: r.status === 401 ? "login" : "error" });
  }, [query]);
  useEffect(() => void load(), [load]);

  async function loadMore() {
    if (view.kind !== "ok" || !view.next || more) return;
    setMore(true);
    setMoreError(false);
    const r = await call<{ orders: Order[]; nextCursor: string | null; counts: Counts }>(query(view.next));
    if (r.ok) setView({ kind: "ok", orders: [...view.orders, ...r.data.orders], next: r.data.nextCursor, counts: r.data.counts });
    else setMoreError(true);
    setMore(false);
  }

  // 취소·환불한 주문의 상품을 장바구니에 다시 담는다(옵션이 아직 있는 것만, 가벼운 쇼핑 행동이라 바로 실행하고 결과만 알린다)
  async function reAdd(o: Order) {
    setMsg(null);
    let added = 0;
    for (const it of o.items) {
      if (!it.optionId) continue;
      const r = await call(`/api/shop/${encodeURIComponent(slug)}/cart`, { method: "POST", body: { optionId: it.optionId, quantity: it.quantity } });
      if (r.ok) added += 1;
    }
    setMsg(added > 0 ? { ok: true, text: `${added}개 상품을 장바구니에 담았어요` } : { ok: false, text: "장바구니에 담지 못했어요. 품절됐거나 판매가 끝난 상품일 수 있어요" });
  }

  const ok = view.kind === "ok" ? view : null;
  const orders = ok?.orders ?? [];
  const periodLabel = PERIODS.find((p) => p.key === period)!.label;

  const filters = ok && (
    <>
      <div className="ol-tabs" role="tablist" aria-label="주문 상태">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label} <span>{ok.counts[t.key]}</span>
          </button>
        ))}
      </div>
      <div className="ol-period" role="group" aria-label="조회 기간">
        {PERIODS.map((p) => (
          <button key={p.key} type="button" className={period === p.key ? "on" : ""} aria-pressed={period === p.key} onClick={() => setPeriod(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
    </>
  );

  const empty =
    ok && orders.length === 0 ? (
      ok.counts.all === 0 && tab === "all" ? (
        period !== "1y" ? (
          <div className="cart-empty">
            <h2>최근 {periodLabel} 주문이 없어요</h2>
            <p>기간을 늘려 보세요.</p>
            <button className="btn btn-out" type="button" onClick={() => setPeriod("1y")}>
              1년 보기
            </button>
          </div>
        ) : (
          <div className="cart-empty">
            <h2>아직 주문이 없어요</h2>
            <p>마음에 드는 상품을 담아 첫 주문을 해 보세요.</p>
            <Link className="btn" href={`${base}/products`}>
              상품 보러 가기
            </Link>
          </div>
        )
      ) : (
        <p className="shop-empty">이 상태의 주문이 없어요.</p>
      )
    ) : null;

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
    ) : (
      <>
        {filters}
        {msg && (
          <p className={msg.ok ? "cart-msg" : "cart-msg is-err"} role="status">
            {msg.text}
            {msg.ok && (
              <Link className="shop-linkbtn" href={`${base}/cart`}>
                장바구니 보기
              </Link>
            )}
          </p>
        )}
        {empty ?? (
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
              {orders.map((o) => {
                const s = stateOf(o);
                const track = o.shipment ? trackingUrl(o.shipment.courier, o.shipment.trackingNumber) : null;
                return (
                  <tr key={o.id}>
                    <td className="ol-date" data-label="주문일 · 번호">
                      <b>{formatDateTime(o.createdAt)}</b>
                      <Link href={`${base}/orders/${o.id}`}>{o.orderNoLabel}</Link>
                    </td>
                    <td className="ol-items" data-label="상품 정보">
                      <ul>
                        {o.items.map((i, n) => (
                          <li key={n}>
                            <span className="ol-thumb" aria-hidden="true">
                              {i.imageUrl && <Image src={i.imageUrl} alt="" width={48} height={48} unoptimized />}
                            </span>
                            <div>
                              <b>{i.productNameSnapshot}</b>
                              <span className="cart-opt">{qtyText(i.optionNameSnapshot, i.quantity)}</span>
                            </div>
                            <b>{won(i.unitPrice * i.quantity)}</b>
                          </li>
                        ))}
                      </ul>
                      <p className="ol-total">결제 금액 {won(o.totalAmount)}</p>
                    </td>
                    <td className="ol-state" data-label="상태">
                      <span className={`ol-tag ol-${s.tone}`}>{s.label}</span>
                      {s.sub && <span className="cart-opt">{s.sub}</span>}
                      {o.status === "PENDING_PAYMENT" && o.paymentDueAt && <span className="cart-opt">{formatDateTime(o.paymentDueAt)}까지 결제</span>}
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
                      {(o.status === "CANCELLED" || o.status === "REFUNDED") && o.items.some((i) => i.optionId) && (
                        <button className="btn btn-sm btn-out" type="button" onClick={() => void reAdd(o)}>
                          다시 담기
                        </button>
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
        {ok?.next && (
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
