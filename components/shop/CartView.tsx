"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import { CART_COUNT_EVENT } from "./ShopChrome";
import { call } from "./reviewShared";
import "./Cart.css";

// SH-004 장바구니(시안 04 SH). 로그인 구매자 전용 API(/api/shop/{slug}/cart)로 목록·수량·삭제를 한다.
type Status = "available" | "not_enough_stock" | "sold_out" | "unavailable";
type PriceChange = { from: number; to: number; diff: number; direction: "up" | "down" };
type Line = {
  id: string;
  productId: string;
  optionId: string;
  productName: string;
  optionName: string;
  quantity: number;
  unitPrice: number;
  listUnitPrice: number;
  lineTotal: number;
  stock: number;
  status: Status;
  priceChange: PriceChange | null; // 담은 뒤 단가가 바뀐 줄(표시용, 금액은 늘 지금 단가)
  maxQuantity: number; // 지금 담을 수 있는 최대 수량(살 수 없으면 0)
  shortage: number; // 재고보다 많이 담긴 수량
  stockLeft: number | null; // 재고가 적을 때만 남은 수
};
type Cart = { items: Line[]; count: number; subtotal: number };
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; cart: Cart };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const unavailable = (l: Line) => l.status === "sold_out" || l.status === "unavailable";

// 「가격 바뀜 확인」: 확인한 줄의 지금 단가(priceChange.to)를 이 기기에 기억한다. 단가가 또 바뀌면 값이 달라져 다시 보인다(기기 간 동기화는 하지 않는다).
const ackKey = (slug: string) => `shop-cart-price-ack:${slug}`;
function readAck(slug: string): Record<string, number> {
  try {
    const v = JSON.parse(window.localStorage.getItem(ackKey(slug)) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function writeAck(slug: string, ack: Record<string, number>) {
  try {
    window.localStorage.setItem(ackKey(slug), JSON.stringify(ack));
  } catch {
    // 저장하지 못해도 이번 화면에서만 숨긴다
  }
}

export default function CartView({ slug }: { slug: string }) {
  const { confirm } = useConfirm();
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/cart`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; undo?: { optionId: string; quantity: number } | { itemId: string; quantity: number } } | null>(null);
  const [ack, setAck] = useState<Record<string, number>>({});
  // 서버 견적(읽기 전용): 고른 줄의 배송비와 결제 예정 금액. 배송지가 없으면 일반 지역 기준이라 제주·도서는 주문서에서 달라질 수 있다.
  const [quote, setQuote] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error" } | { kind: "ok"; shippingFee: number; total: number }>({ kind: "idle" });
  useEffect(() => setAck(readAck(slug)), [slug]);

  const load = useCallback(
    async (keepPick = false) => {
      const r = await call<Cart>(api);
      if (!r.ok) return setView({ kind: r.status === 401 ? "login" : "error" });
      setView({ kind: "ok", cart: r.data });
      window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: r.data.count }));
      setPicked((prev) => {
        const ids = new Set(r.data.items.map((l) => l.id));
        // 처음에는 주문할 수 있는 줄을 모두 고르고, 다시 불러올 때는 남아 있는 선택만 유지한다
        if (!keepPick) return new Set(r.data.items.filter((l) => !unavailable(l)).map((l) => l.id));
        return new Set([...prev].filter((id) => ids.has(id)));
      });
    },
    [api],
  );
  useEffect(() => void load(), [load]);

  const cart = view.kind === "ok" ? view.cart : null;
  const lines = cart?.items ?? [];
  const chosen = useMemo(() => lines.filter((l) => picked.has(l.id) && !unavailable(l)), [lines, picked]);
  const total = chosen.reduce((s, l) => s + l.lineTotal, 0);
  const selectable = lines.filter((l) => !unavailable(l));
  const allPicked = selectable.length > 0 && selectable.every((l) => picked.has(l.id));
  const changed = (l: Line) => (l.priceChange && ack[l.id] !== l.priceChange.to ? l.priceChange : null);
  const changedCount = lines.filter((l) => changed(l)).length;
  function confirmPrice(l: Line) {
    if (!l.priceChange) return;
    const next = { ...ack, [l.id]: l.priceChange.to };
    setAck(next);
    writeAck(slug, next);
  }
  const quoteKey = chosen.map((l) => `${l.optionId}:${l.quantity}`).join(",");
  useEffect(() => {
    if (!quoteKey) return setQuote({ kind: "idle" });
    let live = true;
    setQuote({ kind: "loading" });
    const t = window.setTimeout(async () => {
      const items = quoteKey.split(",").map((x) => ({ optionId: x.split(":")[0], quantity: Number(x.split(":")[1]) }));
      const r = await call<{ shippingFee: number; totalAmount: number }>(`/api/shop/${encodeURIComponent(slug)}/orders/quote`, { method: "POST", body: { items } });
      if (live) setQuote(r.ok ? { kind: "ok", shippingFee: r.data.shippingFee, total: r.data.totalAmount } : { kind: "error" });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [quoteKey, slug]);
  const listTotal = chosen.reduce((s, l) => s + l.listUnitPrice * l.quantity, 0);
  const discount = Math.max(0, listTotal - total);
  const finalTotal = quote.kind === "ok" ? quote.total : total;
  const failMsg = (r: { message?: string }, fallback: string) => r.message ?? fallback;

  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set(p).add(id)));
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(selectable.map((l) => l.id)));

  async function setQty(l: Line, quantity: number) {
    if (busy || quantity < 1 || quantity > 99) return;
    setBusy(true);
    setMsg(null);
    const r = await call(`${api}/${l.id}`, { method: "PATCH", body: { quantity } });
    setMsg(r.ok ? { ok: true, text: `수량을 ${quantity}개로 바꿨어요`, undo: { itemId: l.id, quantity: l.quantity } } : { ok: false, text: failMsg(r, "수량을 바꾸지 못했어요. 잠시 뒤 다시 눌러 주세요") });
    await load(true);
    setBusy(false);
  }

  async function removeOne(l: Line) {
    if (busy) return;
    if (!(await confirm({ tone: "shop", title: "이 상품을 뺄까요?", body: "장바구니에서만 빠져요.", confirmLabel: "빼기" }))) return;
    setBusy(true);
    const r = await call(`${api}/${l.id}`, { method: "DELETE" });
    setMsg(r.ok ? { ok: true, text: "장바구니에서 뺐어요", undo: { optionId: l.optionId, quantity: l.quantity } } : { ok: false, text: failMsg(r, "상품을 빼지 못했어요. 잠시 뒤 다시 눌러 주세요") });
    await load(true);
    setBusy(false);
  }

  async function removeMany(ids: string[], what: string) {
    if (busy || ids.length === 0) return;
    if (!(await confirm({ tone: "shop", title: `${what} ${ids.length}개를 뺄까요?`, body: "장바구니에서만 빠져요.", confirmLabel: "빼기" }))) return;
    setBusy(true);
    const r = await call(api, { method: "DELETE", body: { itemIds: ids } });
    setMsg(r.ok ? { ok: true, text: `${ids.length}개를 장바구니에서 뺐어요` } : { ok: false, text: failMsg(r, "상품을 빼지 못했어요. 잠시 뒤 다시 눌러 주세요") });
    await load(true);
    setBusy(false);
  }

  async function undo(u: { optionId: string; quantity: number } | { itemId: string; quantity: number }) {
    if (busy) return;
    setBusy(true);
    if ("itemId" in u) {
      const r = await call(`${api}/${u.itemId}`, { method: "PATCH", body: { quantity: u.quantity } });
      setMsg(r.ok ? { ok: true, text: `수량을 ${u.quantity}개로 되돌렸어요` } : { ok: false, text: failMsg(r, "되돌리지 못했어요. 잠시 뒤 다시 눌러 주세요") });
      await load(true);
      setBusy(false);
      return;
    }
    const r = await call<{ item: { id: string } }>(api, { method: "POST", body: { optionId: u.optionId, quantity: u.quantity } });
    setMsg(r.ok ? { ok: true, text: "다시 담았어요" } : { ok: false, text: failMsg(r, "다시 담지 못했어요. 잠시 뒤 다시 눌러 주세요") });
    await load(true);
    if (r.ok) setPicked((p) => new Set(p).add(r.data.item.id)); // 되돌린 줄은 다시 고른 상태로
    setBusy(false);
  }

  const head = (
    <div className="cart-head">
      <h1>장바구니</h1>
      <ol className="cart-steps" aria-label="주문 단계">
        <li aria-current="step">
          <i>01</i>장바구니
        </li>
        <li>
          <i>02</i>주문서
        </li>
        <li>
          <i>03</i>주문 완료
        </li>
      </ol>
    </div>
  );

  if (view.kind === "loading")
    return (
      <div className="shop-wrap cart-wrap" aria-busy="true">
        {head}
        <p className="shop-empty">장바구니를 불러오고 있어요</p>
      </div>
    );
  if (view.kind === "login")
    return (
      <div className="shop-wrap cart-wrap">
        {head}
        <div className="cart-empty">
          <p>로그인하면 장바구니를 볼 수 있어요.</p>
          <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/cart`)}`}>
            로그인
          </Link>
        </div>
      </div>
    );
  if (view.kind === "error")
    return (
      <div className="shop-wrap cart-wrap">
        {head}
        <div className="cart-empty">
          <p>장바구니를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p>
          <button className="btn" type="button" onClick={() => void load()}>
            다시 불러오기
          </button>
        </div>
      </div>
    );
  if (lines.length === 0)
    return (
      <div className="shop-wrap cart-wrap">
        {head}
        <div className="cart-empty">
          <h2>장바구니가 비어 있어요</h2>
          <p>방송 중 상품을 담아 두면 결제까지 바로 이어져요.</p>
          <Link className="btn" href={`${base}/products`}>
            상품 보러 가기
          </Link>
        </div>
      </div>
    );

  const unavail = lines.filter(unavailable);
  const orderHref = `${base}/checkout?ids=${chosen.map((l) => l.id).join(",")}`;
  return (
    <div className="shop-wrap cart-wrap">
      {head}
      {changedCount > 0 && (
        <p className="cart-msg" role="status">
          담은 뒤 가격이 바뀐 상품이 {changedCount}개 있어요. 결제 금액은 지금 가격으로 계산돼요.
        </p>
      )}
      {msg && (
        <p className={`cart-msg${msg.ok ? "" : " is-err"}`} role="status">
          {msg.text}
          {msg.undo && (
            <button type="button" className="shop-linkbtn" onClick={() => void undo(msg.undo!)}>
              되돌리기
            </button>
          )}
        </p>
      )}
      <div className="cart-two">
        <div>
          <div className="cart-mbar">
            <label className="chk">
              <input type="checkbox" className="cbx" checked={allPicked} onChange={toggleAll} disabled={selectable.length === 0} />
              전체 선택 ({chosen.length}/{lines.length})
            </label>
            <button className="btn btn-sm btn-out" type="button" disabled={busy || chosen.length === 0} onClick={() => void removeMany(chosen.map((l) => l.id), "선택한 상품")}>
              선택 삭제
            </button>
          </div>
          <table className="cart-tbl">
            <thead>
              <tr>
                <th className="c-chk">
                  <input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="전체 선택" disabled={selectable.length === 0} />
                </th>
                <th>상품 정보</th>
                <th className="c-qty">수량</th>
                <th className="c-price">금액</th>
                <th className="c-del">관리</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const out = unavailable(l);
                return (
                  <tr key={l.id} className={out ? "is-out" : undefined}>
                    <td className="c-chk">
                      <input type="checkbox" checked={picked.has(l.id) && !out} disabled={out} onChange={() => toggle(l.id)} aria-label={`${l.productName} 선택`} />
                    </td>
                    <td className="c-info">
                      <Link href={`${base}/products/${l.productId}`}>
                        <b>{l.productName}</b>
                      </Link>
                      <span className="cart-opt">{l.optionName}</span>
                      {out && <span className="cart-tag">품절 · 주문에서 빠져요</span>}
                      {l.status === "not_enough_stock" && (
                        <span className="cart-tag">
                          재고가 부족해요 · 최대 {l.maxQuantity}개
                          {l.shortage > 0 && l.maxQuantity >= 1 && (
                            <button type="button" className="shop-linkbtn" disabled={busy} onClick={() => void setQty(l, l.maxQuantity)}>
                              {l.maxQuantity}개로 줄이기
                            </button>
                          )}
                        </span>
                      )}
                      {l.status === "available" && l.stockLeft !== null && <span className="cart-tag">{l.stockLeft}개 남았어요</span>}
                      {!out && changed(l) && (
                        <span className="cart-tag cart-price-tag">
                          담은 뒤 가격이 {changed(l)!.direction === "up" ? "올랐어요" : "내렸어요"} · {won(changed(l)!.from)} → {won(changed(l)!.to)}
                          <button type="button" className="shop-linkbtn" onClick={() => confirmPrice(l)}>
                            바뀐 가격 확인했어요
                          </button>
                        </span>
                      )}
                    </td>
                    <td className="c-qty">
                      {out ? (
                        "—"
                      ) : (
                        <span className="cart-qty">
                          <button type="button" aria-label="수량 줄이기" disabled={busy || l.quantity <= 1} onClick={() => void setQty(l, l.quantity - 1)}>
                            −
                          </button>
                          <span aria-label={`수량 ${l.quantity}개`}>{l.quantity}</span>
                          <button type="button" aria-label="수량 늘리기" disabled={busy || l.quantity >= Math.min(99, l.maxQuantity || 99)} onClick={() => void setQty(l, l.quantity + 1)}>
                            +
                          </button>
                        </span>
                      )}
                    </td>
                    <td className="c-price">
                      <b>{won(l.lineTotal)}</b>
                    </td>
                    <td className="c-del">
                      <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void removeOne(l)}>
                        삭제
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="cart-tools">
            <button className="btn btn-sm btn-out" type="button" disabled={busy || chosen.length === 0} onClick={() => void removeMany(chosen.map((l) => l.id), "선택한 상품")}>
              선택 삭제
            </button>
            <button className="btn btn-sm btn-out" type="button" disabled={busy || unavail.length === 0} onClick={() => void removeMany(unavail.map((l) => l.id), "품절 상품")}>
              품절 상품 삭제
            </button>
            <Link className="btn btn-sm btn-out cart-more" href={`${base}/products`}>
              계속 쇼핑하기
            </Link>
          </div>
        </div>
        <aside className="cart-sum" aria-label="주문 금액">
          <div className="cart-row">
            <span>상품 금액 ({chosen.length}개)</span>
            <b>{won(chosen.length > 0 ? listTotal : 0)}</b>
          </div>
          {discount > 0 && (
            <div className="cart-row">
              <span>할인 (쿠폰은 주문서에서 선택)</span>
              <span>−{won(discount)}</span>
            </div>
          )}
          {chosen.length > 0 && (
            <>
              <div className="cart-row">
                <span>배송비</span>
                <span>{quote.kind === "ok" ? won(quote.shippingFee) : quote.kind === "error" ? "주문서에서 알려 드려요" : "계산하고 있어요"}</span>
              </div>
              <div className="cart-row cart-total">
                <span>결제 예정 금액</span>
                <b>{quote.kind === "ok" ? won(quote.total) : "—"}</b>
              </div>
            </>
          )}
          {chosen.length > 0 ? (
            <Link className="btn btn-lg btn-block" href={orderHref}>
              {won(finalTotal)} 주문하기
            </Link>
          ) : (
            <button className="btn btn-lg btn-block" type="button" disabled>
              주문할 상품을 골라 주세요
            </button>
          )}
          <p className="cart-hint">방송 중 주문은 결제가 끝난 순서대로 방송에서 상품을 열어 드려요. 품절 상품은 주문에서 자동으로 빠져요</p>
        </aside>
      </div>
    </div>
  );
}
