"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { call } from "./reviewShared";
import { trackingUrl } from "./trackingLink";
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
  items: { productNameSnapshot: string; optionNameSnapshot: string; quantity: number; optionId?: string | null; orderItemId?: string | null }[];
  shipment: { status: "READY" | "IN_TRANSIT" | "DELIVERED"; courier: string; trackingNumber: string } | null;
};
// 보드 SH-020-PC-IA 「관리」 열: 상태별 버튼. 취소 요청은 주문 상세의 신청 칸으로 보낸다.
type Act = { kind: "link"; label: string; href: string; external?: boolean } | { kind: "readd"; label: string };
function actionsOf(o: Order, watchUrl: string | null, base: string): Act[] {
  const detail = `${base}/orders/${o.id}`;
  if (o.status === "PENDING_PAYMENT") return [{ kind: "link", label: "결제하기", href: detail }];
  if (o.status === "CANCELLED" || o.status === "REFUNDED") return o.items.some((i) => i.optionId) ? [{ kind: "readd", label: "다시 담기" }] : [{ kind: "link", label: "주문 상세", href: detail }];
  if (o.shipment?.status === "DELIVERED") return [{ kind: "link", label: "리뷰 쓰기", href: o.items[0]?.orderItemId ? `${base}/reviews?item=${encodeURIComponent(o.items[0].orderItemId)}` : `${base}/reviews` }];
  const track = o.shipment ? trackingUrl(o.shipment.courier, o.shipment.trackingNumber) : null;
  if (o.shipment) return track ? [{ kind: "link", label: "배송 조회", href: track, external: true }] : [{ kind: "link", label: "주문 상세", href: detail }];
  const list: Act[] = [{ kind: "link", label: "취소 요청", href: detail }];
  if (o.queue && o.queue.status !== "DONE" && watchUrl) list.push({ kind: "link", label: "방송 보기", href: watchUrl, external: true });
  return list;
}
type Orders = { orders: Order[]; nextCursor?: string | null; counts: { inProgress: number } };
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
  const [active, setActive] = useState<Orders | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [coupons, setCoupons] = useState<Coupons | null>(null);
  const [failed, setFailed] = useState(false);
  const [watchUrl, setWatchUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    // 최근 주문 표는 최근 5건, 기다리는 주문은 진행 중 탭 전체(1년 안, 최대 50건)에서 센다(최근 몇 건만 보고 총계로 쓰지 않는다)
    const from = new Date(Date.now() + 9 * 3600_000 - 364 * 86_400_000).toISOString().slice(0, 10);
    void Promise.all([call<Orders>(`${api}/orders?limit=${RECENT}`), call<Orders>(`${api}/orders?tab=inProgress&limit=50&from=${from}`), call<Rewards>(`${api}/me/rewards`), call<Coupons>(`${api}/coupons`)]).then(([o, a, r, c]) => {
      if (!live) return;
      if (o.ok) setOrders(o.data);
      if (a.ok) setActive(a.data);
      if (r.ok) setRewards(r.data);
      if (c.ok) setCoupons(c.data);
      setFailed(!o.ok || !a.ok || !r.ok || !c.ok);
    });
    // 「방송 보기」는 방송 연결 주소가 있을 때만 쓴다(LiveBar와 같은 기준)
    void call<{ live: boolean; watchUrl?: string | null }>(`${api}/live`).then((l) => {
      if (live && l.ok && l.data.live && l.data.watchUrl) setWatchUrl(l.data.watchUrl);
    });
    return () => {
      live = false;
    };
  }, [api]);

  const waiting = active?.orders.filter((o) => !o.shipment && o.queue?.status === "WAITING") ?? [];
  const ahead = waiting.length ? Math.min(...waiting.map((o) => o.queue!.aheadCount)) : null;
  const usable = coupons?.usable.filter((c) => c.state === "usable") ?? [];
  const soonest = usable.length ? usable.map((c) => c.expiresAt).sort()[0] : null;
  const soonestN = soonest ? usable.filter((c) => c.expiresAt.slice(0, 10) === soonest.slice(0, 10)).length : 0;
  const recent = orders?.orders ?? [];
  const dash = "–";
  async function reAdd(o: Order) {
    setMsg(null);
    let added = 0;
    for (const it of o.items) {
      if (!it.optionId) continue;
      const r = await call(`${api}/cart`, { method: "POST", body: { optionId: it.optionId, quantity: it.quantity } });
      if (r.ok) added += 1;
    }
    setMsg(added > 0 ? { ok: true, text: `${added}개 상품을 장바구니에 담았어요` } : { ok: false, text: "장바구니에 담지 못했어요. 품절됐거나 판매가 끝난 상품일 수 있어요" });
  }

  return (
    <div className="hub">
      <div className="hub-stats" aria-label="내 요약">
        <Link className="hub-stat" href={`${base}/orders`}>
          <span className="hub-k">기다리는 주문</span>
          <b className="hub-v">{active ? `${waiting.length}${active.nextCursor ? "건 이상" : "건"}` : dash}</b>
          <span className="hub-s">{active ? (ahead !== null ? `앞에 ${ahead}명` : active.counts.inProgress ? `진행 중 ${active.counts.inProgress}건` : "기다리는 주문이 없어요") : ""}</span>
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
                    <td className="hub-act">
                      {actionsOf(o, watchUrl, base).map((a) =>
                        a.kind === "readd" ? (
                          <button key={a.label} className="btn btn-out btn-sm" type="button" onClick={() => void reAdd(o)}>
                            {a.label}
                          </button>
                        ) : a.external ? (
                          <a key={a.label} className="btn btn-out btn-sm" href={a.href} target="_blank" rel="noopener noreferrer">
                            {a.label}
                          </a>
                        ) : (
                          <Link key={a.label} className="btn btn-out btn-sm" href={a.href}>
                            {a.label}
                          </Link>
                        ),
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {msg && (
          <p className={`msg ${msg.ok ? "msg-pos" : "msg-neg"} t-l2`} role="status">
            {msg.text}
          </p>
        )}
      </section>
    </div>
  );
}
