"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ProductCard, type ProductCardData } from "./ProductCard";
import type { ShopProduct } from "./ProductDetail";
import { CART_COUNT_EVENT } from "./ShopChrome";
import ShopModal from "./ShopModal";
import { call } from "./reviewShared";
import { minorModeOf, useMinorToast } from "./MinorPurchase";

type Section = { kind: string; title: string; categoryId?: string | null; products: ProductCardData[] };
type Choice = { product: ProductCardData; options: ShopProduct["options"]; optionId: string };

// 홈의 모든 진열 영역이 같은 찜 상태를 쓴다. 담기는 찜 화면과 같은 최신 옵션 조회·선택 경로를 사용한다.
export default function HomeProducts({ slug, loggedIn, sections, live }: { slug: string; loggedIn: boolean; sections: Section[]; live: boolean }) {
  const base = `/shop/${encodeURIComponent(slug)}`, api = `/api/shop/${encodeURIComponent(slug)}`;
  const [wished, setWished] = useState<Set<string>>(new Set());
  const [wishReady, setWishReady] = useState(!loggedIn);
  const [busy, setBusy] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [message, setMessage] = useState<{ text: string; cart?: boolean } | null>(null);
  const minor = useMinorToast();
  const ids = [...new Set(sections.flatMap(s => s.products.map(p => p.id)))].join(",");
  useEffect(() => {
    let active = true;
    setWished(new Set());
    setWishReady(!loggedIn || !ids);
    if (loggedIn && ids) void (async () => {
      const products = ids.split(","), found: string[] = [];
      // 기존 찜 ID 조회의 최대 100개 계약을 지키며 전체 진열을 읽는다.
      for (let i = 0; i < products.length; i += 100) {
        const r = await call<{ productIds: string[] }>(`${api}/wishlist?ids=1&productIds=${products.slice(i, i + 100).join(",")}`);
        if (!r.ok) { if (active) setMessage({ text: "찜 상태를 불러오지 못했어요. 새로고침해 주세요" }); return; }
        found.push(...r.data.productIds);
      }
      if (active) { setWished(new Set(found)); setWishReady(true); }
    })();
    return () => { active = false; };
  }, [api, loggedIn, ids]);

  async function add(optionId: string) {
    if (busy) return;
    setBusy(true); setMessage(null);
    const r = await call<{ item: { id: string }; count: number }>(`${api}/cart`, { method: "POST", body: { optionId, quantity: 1 } });
    setBusy(false); setChoice(null);
    if (!r.ok && r.status === 401) return setNeedLogin(true);
    const mode = minorModeOf(r);
    if (mode) return minor.show(mode);
    if (!r.ok) return setMessage({ text: r.message ?? "담지 못했어요. 잠시 뒤 다시 해 주세요" });
    window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: r.data.count }));
    setMessage({ text: "장바구니에 담았어요", cart: true });
  }
  async function prepare(product: ProductCardData) {
    if (busy || product.soldOut) return;
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true); setMessage(null);
    const r = await call<{ product: Pick<ShopProduct, "id" | "options"> }>(`${api}/products/${product.id}?view=options`);
    const options = r.ok && r.data.product.id === product.id ? r.data.product.options.filter(o => !o.soldOut) : [];
    setBusy(false);
    if (!r.ok || !options.length) return setMessage({ text: r.ok ? "담을 수 있는 옵션이 없어요" : r.message ?? "상품을 불러오지 못했어요" });
    if (options.length === 1) return void add(options[0].id);
    setChoice({ product, options, optionId: options[0].id });
  }
  async function wish(productId: string) {
    if (busy || !wishReady) return;
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true); setMessage(null);
    const wasWished = wished.has(productId);
    const r = wasWished ? await call(`${api}/wishlist/${productId}`, { method: "DELETE" }) : await call(`${api}/wishlist`, { method: "POST", body: { productId } });
    setBusy(false);
    if (!r.ok && r.status === 401) return setNeedLogin(true);
    if (r.ok || (wasWished && r.status === 404)) {
      setWished(prev => { const next = new Set(prev); if (wasWished) next.delete(productId); else next.add(productId); return next; });
      setMessage({ text: wasWished ? "찜에서 뺐어요" : "찜했어요" });
    } else setMessage({ text: r.message ?? "찜하지 못했어요. 잠시 뒤 다시 해 주세요" });
  }

  return <>
    {sections.map((section, i) => {
      const title = section.kind === "LIVE" && !live && section.title === "방송 중 상품" ? "최근 방송 상품" : section.title;
      return <section className={`shop-sec shop-home-kind-${section.kind.toLowerCase()}`} key={`${section.kind}-${section.categoryId ?? i}`} aria-labelledby={`home-products-${i}`}>
        <div className="shop-sec-head"><h2 id={`home-products-${i}`}>{title}</h2><span className="shop-home-sub">{section.kind === "LIVE" ? live ? "지금 여는 상품" : "최근 방송에서 연 상품" : section.kind === "RECOMMENDED" ? "판매자가 고른 순서" : section.kind === "NEW" ? "7일 안 등록" : ""}</span><Link className="shop-more" href={`${base}/products${section.kind === "NEW" ? "?sort=new" : section.categoryId ? `?category=${section.categoryId}` : section.kind === "LIVE" && live ? "?live=1" : ""}`}>더 보기 ›</Link></div>
        <ul className="pc-grid" aria-label={title}>{section.products.map(product => <ProductCard key={product.id} p={product} href={`${base}/products/${product.id}`}>
          <div className="home-card-actions">
            <button className="btn btn-sm btn-out home-card-wish" type="button" aria-label={wished.has(product.id) ? "찜 빼기" : "찜"} aria-pressed={wished.has(product.id)} disabled={busy || !wishReady} onClick={() => void wish(product.id)}>{wished.has(product.id) ? "♥" : "♡"}</button>
            <button className="btn btn-sm btn-out home-card-cart" type="button" disabled={busy || product.soldOut} onClick={() => void prepare(product)}>담기</button>
          </div>
        </ProductCard>)}</ul>
      </section>;
    })}
    {message && <p className="shop-empty" role="status">{message.text}{message.cart && <> · <Link href={`${base}/cart`}>장바구니 보기</Link></>}</p>}
    {choice && <ShopModal title={`${choice.product.name} 옵션 선택`} onClose={() => setChoice(null)} busy={busy} footer={<><button className="btn btn-out" type="button" disabled={busy} onClick={() => setChoice(null)}>취소</button><button className="btn" type="button" disabled={busy} onClick={() => void add(choice.optionId)}>담기</button></>}>
      <select className="inp" aria-label="상품 옵션" value={choice.optionId} onChange={event => setChoice({ ...choice, optionId: event.target.value })}>{choice.options.map(option => <option key={option.id} value={option.id}>{option.name} · {(option.salePrice ?? option.price).toLocaleString("ko-KR")}원</option>)}</select>
    </ShopModal>}
    {needLogin && <ShopModal title="로그인이 필요해요" onClose={() => setNeedLogin(false)} footer={<><Link className="btn" href={`${base}/login?next=${encodeURIComponent(base)}`}>로그인</Link><button type="button" className="btn btn-out" onClick={() => setNeedLogin(false)}>둘러보기</button></>}><p>회원만 주문할 수 있어요. 가입은 1분이면 돼요.</p></ShopModal>}
    {minor.node}
  </>;
}
