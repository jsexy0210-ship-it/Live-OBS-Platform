"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import MyMenu from "./MyMenu";
import { ProductCard, ProductGrid, type ProductCardData } from "./ProductCard";
import { readRecent } from "./RecentProducts";
import { call } from "./reviewShared";
import ShopModal from "./ShopModal";
import "./Cart.css";
import "./MyMenu.css";

// SH-034 찜(시안 04 SH). 로그인 구매자 전용 API(/api/shop/{slug}/wishlist)로 목록·빼기. 「담기·바로 구매」는 상품 상세·옵션 API가 생기면, 「최근 본 상품」은 상품 상세가 이 기기에 남긴 목록(RecentProducts)을 탭으로 보여 준다.
type Item = { productId: string; name: string; price: number; listPrice: number; status: "on_sale" | "sold_out" | "unavailable"; wishedAt: string };
type View = { kind: "loading" } | { kind: "login" } | { kind: "error" } | { kind: "ok"; items: Item[] };

const card = (i: Item): ProductCardData => ({ id: i.productId, name: i.name, price: i.listPrice, salePrice: i.price < i.listPrice ? i.price : null, soldOut: i.status === "sold_out" });

export default function WishlistView({ slug }: { slug: string }) {
  const { confirm } = useConfirm();
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/wishlist`;
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; undo?: string[] } | null>(null);
  const [tab, setTab] = useState<"wish" | "recent">("wish");
  // 최근 본 상품은 이 기기 localStorage(상품 상세가 남김, 서버 값 없음)
  const [recent, setRecent] = useState<ProductCardData[]>([]);
  useEffect(() => setRecent(readRecent(slug)), [slug]);

  const load = useCallback(async () => {
    const r = await call<{ items: Item[] }>(api);
    setView(r.ok ? { kind: "ok", items: r.data.items } : { kind: r.status === 401 ? "login" : "error" });
  }, [api]);
  useEffect(() => void load(), [load]);

  async function remove(items: Item[], text: string) {
    if (busy || items.length === 0) return;
    setBusy(true);
    setMsg(null);
    let failed = 0;
    for (const i of items) {
      const r = await call(`${api}/${i.productId}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) failed += 1;
    }
    setMsg(failed === 0 ? { ok: true, text, undo: items.map((i) => i.productId) } : { ok: false, text: "일부를 빼지 못했어요. 잠시 뒤 다시 해 주세요" });
    setConfirming(false);
    await load();
    setBusy(false);
  }

  // 되돌리기: 뺀 상품을 다시 찜한다(품절이 된 상품 등 못 찜하는 것은 건너뛰고 개수를 알린다)
  async function undo(ids: string[]) {
    if (busy) return;
    setBusy(true);
    let back = 0;
    for (const productId of ids) if ((await call(api, { method: "POST", body: { productId } })).ok) back += 1;
    setMsg(back === ids.length ? { ok: true, text: "다시 찜했어요" } : back > 0 ? { ok: false, text: `${back}개만 다시 찜했어요. 나머지는 찜할 수 없는 상품이에요` } : { ok: false, text: "다시 찜하지 못했어요. 잠시 뒤 다시 해 주세요" });
    await load();
    setBusy(false);
  }

  const msgEl = msg && (
    <p className={`cart-msg${msg.ok ? "" : " is-err"}`} role="status">
      {msg.text}
      {msg.undo && (
        <button type="button" className="shop-linkbtn" disabled={busy} onClick={() => void undo(msg.undo!)}>
          되돌리기
        </button>
      )}
    </p>
  );

  const items = view.kind === "ok" ? view.items : [];
  const out = items.filter((i) => i.status !== "on_sale");
  const body =
    view.kind === "loading" ? (
      <p className="shop-empty" aria-busy="true">
        찜한 상품을 불러오고 있어요
      </p>
    ) : view.kind === "login" ? (
      <div className="cart-empty">
        <p>로그인하면 찜한 상품을 볼 수 있어요.</p>
        <Link className="btn" href={`${base}/login?next=${encodeURIComponent(`${base}/wishlist`)}`}>
          로그인
        </Link>
      </div>
    ) : view.kind === "error" ? (
      <div className="cart-empty">
        <p>찜한 상품을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.</p>
        <button className="btn" type="button" onClick={() => void load()}>
          다시 불러오기
        </button>
      </div>
    ) : items.length === 0 ? (
      <div className="cart-empty">
        {msgEl}
        <h2>찜한 상품이 없어요</h2>
        <p>상품 상세에서 하트를 누르면 이곳에 모여요.</p>
        <Link className="btn" href={`${base}/products`}>
          상품 보러 가기
        </Link>
      </div>
    ) : (
      <>
        {msgEl}
        <ul className="pc-grid" aria-label="찜한 상품">
          {items.map((i) => (
            <ProductCard key={i.productId} p={card(i)} href={i.status === "unavailable" ? undefined : `${base}/products/${i.productId}`}>
              {i.status === "unavailable" && <p className="cart-tag">지금은 판매하지 않아요</p>}
              <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void remove([i], "찜에서 뺐어요")}>
                찜 빼기
              </button>
            </ProductCard>
          ))}
        </ul>
        <div className="cart-tools">
          <button className="btn btn-sm btn-out" type="button" disabled={busy || out.length === 0} onClick={async () => {
              if (await confirm({ tone: "shop", title: `품절 상품 ${out.length}개를 뺄까요?`, body: "찜 목록에서만 빠져요.", confirmLabel: "빼기" })) void remove(out, `${out.length}개를 찜에서 뺐어요`);
            }}>
            품절 상품 빼기
          </button>
          <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => setConfirming(true)}>
            모두 비우기
          </button>
        </div>
      </>
    );

  return (
    <div className="shop-wrap cart-wrap">
      <div className="cart-head">
        <h1>찜 · 최근 본 상품</h1>
      </div>
      <div className="my-wrap">
        <MyMenu slug={slug} />
        <div>
          {view.kind === "ok" && (
            <div className="tabs wl-tabs" role="tablist">
              {(
                [
                  ["wish", "찜", items.length],
                  ["recent", "최근 본 상품", recent.length],
                ] as const
              ).map(([k, label, n]) => (
                <button key={k} className={`tab${tab === k ? " on" : ""}`} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {label}
                  <span className="cnt">{n}</span>
                </button>
              ))}
            </div>
          )}
          {view.kind === "ok" && tab === "recent" ? (
            recent.length === 0 ? (
              <div className="cart-empty">
                <h2>최근 본 상품이 없어요</h2>
                <p>상품을 둘러보면 이곳에 모여요.</p>
                <Link className="btn" href={`${base}/products`}>
                  상품 보러 가기
                </Link>
              </div>
            ) : (
              <ProductGrid products={recent} label="최근 본 상품" hrefBase={`${base}/products`} />
            )
          ) : (
            body
          )}
        </div>
      </div>
      {confirming && (
        <ShopModal
          title={`${items.length}개를 모두 뺄까요?`}
          onClose={() => setConfirming(false)}
          busy={busy}
          footer={
            <>
              <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirming(false)}>
                취소
              </button>
              <button className="btn btn-neg" type="button" disabled={busy} onClick={() => void remove(items, "찜을 모두 비웠어요")}>
                모두 빼기
              </button>
            </>
          }
        >
          찜 목록에서만 빠져요. 상품은 그대로예요.
        </ShopModal>
      )}
    </div>
  );
}
