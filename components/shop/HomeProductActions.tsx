"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { call } from "./reviewShared";
import { CART_COUNT_EVENT } from "./ShopChrome";

const HOME_WISH_EVENT = "shop-home-wish-change";

// 홈에서도 상세 화면과 같은 장바구니·찜 API를 사용한다. 옵션이 여럿이면 상세에서 고른다.
export default function HomeProductActions({ slug, productId, optionId, soldOut }: { slug: string; productId: string; optionId: string | null; soldOut: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [wished, setWished] = useState(false);
  const [message, setMessage] = useState("");
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}`;
  useEffect(() => {
    let active = true;
    let changed = false;
    const onWish = (event: Event) => {
      const detail = (event as CustomEvent<{ slug: string; productId: string; wished: boolean }>).detail;
      if (detail.slug !== slug || detail.productId !== productId) return;
      changed = true;
      setWished(detail.wished);
    };
    window.addEventListener(HOME_WISH_EVENT, onWish);
    void call<{ productIds: string[] }>(`${api}/wishlist?ids=1&productIds=${productId}`).then(r => { if (active && !changed && r.ok) setWished(r.data.productIds.includes(productId)); });
    return () => { active = false; window.removeEventListener(HOME_WISH_EVENT, onWish); };
  }, [api, productId, slug]);

  async function act(kind: "wish" | "cart" | "buy") {
    if (busy) return;
    if (kind !== "wish" && !optionId) { router.push(`${base}/products/${productId}`); return; }
    setBusy(true);
    const result = kind === "wish" ? await call(`${api}/wishlist${wished ? `/${productId}` : ""}`, { method: wished ? "DELETE" : "POST", body: wished ? undefined : { productId } }) : await call<{ item: { id: string }; count: number }>(`${api}/cart`, { method: "POST", body: { optionId, quantity: 1 } });
    if (!result.ok && result.status === 401) router.push(`${base}/login`);
    else if (!result.ok) setMessage(result.message || "처리하지 못했어요. 잠시 뒤 다시 해 주세요");
    else if (kind === "wish") {
      window.dispatchEvent(new CustomEvent(HOME_WISH_EVENT, { detail: { slug, productId, wished: !wished } }));
      setMessage(wished ? "찜에서 뺐어요" : "찜했어요");
    }
    else {
      const data = result.data as { item: { id: string }; count: number };
      window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: data.count }));
      if (kind === "buy") router.push(`${base}/checkout?ids=${data.item.id}`);
      else setMessage("장바구니에 담았어요");
    }
    setBusy(false);
  }

  return <><div className="shop-home-actions">
    {soldOut ? <button className="btn s" disabled>품절</button> : <>
      <button type="button" className="btn s shop-home-wish" aria-label={wished ? "찜 취소" : "찜"} aria-pressed={wished} disabled={busy} onClick={() => void act("wish")}>{wished ? "♥" : "♡"}</button>
      <button type="button" className="btn s" disabled={busy} onClick={() => void act("cart")}>담기</button>
      <button type="button" className="btn s p shop-home-buy" disabled={busy} onClick={() => void act("buy")}>바로 구매</button>
    </>}
  </div>{message && <p className="shop-home-action-message" role="status">{message}</p>}</>;
}
