"use client";

import CouponRow from "./CouponRow";
import DetailTabs from "./DetailTabs";
import LiveNotice from "./LiveNotice";
import ProductInquiries from "./ProductInquiries";
import ProductReviews from "./ProductReviews";
import RecentProducts from "./RecentProducts";
import RecommendedProducts from "./RecommendedProducts";
import ShopBack from "./ShopBack";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { call } from "./reviewShared";
import { kstDate } from "./kstDate";
import { CART_COUNT_EVENT } from "./ShopChrome";
import ShopModal from "./ShopModal";
import "./Cart.css";
import "./ProductDetail.css";

// SH-003 상품 상세(시안 04 SH). 값은 공개 상품 상세 조회(shopProductDetail)를 그대로 받는다.
// 장바구니·찜은 로그인한 구매자만: 로그인 전이면 「로그인이 필요해요」 창. 「구매하기」는 장바구니에 담은 줄만 골라 주문서로 보낸다(주문 바로 만들기 API가 없음).
type Option = { id: string; name: string; price: number; salePrice: number | null; soldOut: boolean; stockLeft: number | null };
type Block = { type: "text"; text: string } | { type: "image"; imageId: string; url: string; width: number; height: number };
export type ShopProduct = {
  id: string;
  isLive?: boolean;
  name: string;
  description: string | null;
  price: number;
  salePrice: number | null;
  event: { endsAt: string | null } | null;
  soldOut: boolean;
  images: { id: string; url: string; width: number; height: number }[];
  options: Option[];
  detail: Block[];
  shipping: { freeShipping: boolean; baseFee: number; freeOverAmount: number | null; remoteSurcharge: number };
  reward: { card: { rate: number; amount: number } | null; bankTransfer: { rate: number; amount: number } | null } | null;
};

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const QTY_MAX = 99;

export default function ProductDetail({ slug, loggedIn, product: p, crumb = [] }: { slug: string; loggedIn: boolean; product: ShopProduct; crumb?: { id: string; name: string }[] }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}`;
  const router = useRouter();
  const firstOpen = p.options.find((o) => !o.soldOut) ?? p.options[0];
  const [optionId, setOptionId] = useState(firstOpen?.id ?? "");
  const [qty, setQty] = useState(1);
  const [photo, setPhoto] = useState(0);
  const [wished, setWished] = useState(false);
  const [restock, setRestock] = useState(false); // 재입고 알림을 신청했는지(상품이 품절일 때만 쓴다)
  const [busy, setBusy] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; cart?: boolean } | null>(null);

  const option = p.options.find((o) => o.id === optionId);
  const unit = option ? (option.salePrice ?? option.price) : (p.salePrice ?? p.price);
  const maxQty = Math.min(QTY_MAX, option?.stockLeft ?? QTY_MAX);
  const rate = p.salePrice !== null ? Math.floor(((p.price - p.salePrice) / p.price) * 100) : 0;
  const out = p.soldOut || !option || option.soldOut;
  const hero = p.images[photo] ?? null;

  useEffect(() => {
    if (!loggedIn) return;
    let live = true;
    call<{ productIds: string[] }>(`${api}/wishlist?ids=1&productIds=${p.id}`).then((r) => live && r.ok && setWished(r.data.productIds.includes(p.id)));
    return () => {
      live = false;
    };
  }, [api, loggedIn, p.id]);

  useEffect(() => {
    if (!loggedIn || !p.soldOut) return;
    let live = true;
    call<{ items: { productId: string }[] }>(`${api}/restock-alerts`).then((r) => live && r.ok && setRestock(r.data.items.some((i) => i.productId === p.id)));
    return () => {
      live = false;
    };
  }, [api, loggedIn, p.id, p.soldOut]);

  async function onRestock() {
    if (busy) return;
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true);
    setMsg(null);
    const r = restock ? await call(`${api}/restock-alerts/${p.id}`, { method: "DELETE" }) : await call(`${api}/restock-alerts`, { method: "POST", body: { productId: p.id } });
    if (r.ok || (restock && r.status === 404)) {
      setRestock(!restock);
      setMsg({ ok: true, text: restock ? "재입고 알림을 취소했어요" : "다시 입고되면 알려 드릴게요" });
    } else setMsg({ ok: false, text: r.message ?? "처리하지 못했어요. 잠시 뒤 다시 해 주세요" });
    setBusy(false);
  }

  function pickOption(id: string) {
    setOptionId(id);
    setQty(1);
    setMsg(null);
  }
  function changeQty(n: number) {
    setMsg(null);
    if (n > maxQty) return setMsg({ ok: false, text: `${maxQty}개까지 주문할 수 있어요` });
    setQty(Math.max(1, n));
  }

  async function addToCart() {
    const r = await call<{ item: { id: string }; count: number }>(`${api}/cart`, { method: "POST", body: { optionId, quantity: qty } });
    if (r.ok) window.dispatchEvent(new CustomEvent(CART_COUNT_EVENT, { detail: r.data.count }));
    return r;
  }
  async function onCart() {
    if (busy || out) return;
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true);
    setMsg(null);
    const r = await addToCart();
    setMsg(r.ok ? { ok: true, text: "장바구니에 담았어요", cart: true } : { ok: false, text: r.message ?? "담지 못했어요. 잠시 뒤 다시 해 주세요" });
    setBusy(false);
  }
  async function onBuy() {
    if (busy || out) return;
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true);
    setMsg(null);
    const r = await addToCart();
    if (r.ok) return router.push(`${base}/checkout?ids=${r.data.item.id}`);
    setMsg({ ok: false, text: r.message ?? "주문서로 가지 못했어요. 잠시 뒤 다시 해 주세요" });
    setBusy(false);
  }
  async function onWish() {
    if (busy) return;
    if (!loggedIn) return setNeedLogin(true);
    setBusy(true);
    setMsg(null);
    const r = wished ? await call(`${api}/wishlist/${p.id}`, { method: "DELETE" }) : await call(`${api}/wishlist`, { method: "POST", body: { productId: p.id } });
    if (r.ok || (wished && r.status === 404)) setWished(!wished);
    else setMsg({ ok: false, text: r.message ?? "찜하지 못했어요. 잠시 뒤 다시 해 주세요" });
    setBusy(false);
  }

  async function onShare() {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: p.name, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setMsg({ ok: true, text: "상품 주소를 복사했어요" });
    } catch (e) {
      // 공유 창을 닫은 것은 오류가 아니다
      if (!(e instanceof DOMException && e.name === "AbortError")) setMsg({ ok: false, text: "공유하지 못했어요. 주소 줄에서 복사해 주세요" });
    }
  }

  const here = `${base}/products/${p.id}`;
  const ship = p.shipping.freeShipping
    ? "무료"
    : `${won(p.shipping.baseFee)}${p.shipping.freeOverAmount ? ` · ${won(p.shipping.freeOverAmount)} 이상 무료` : ""}${p.shipping.remoteSurcharge ? ` · 제주·도서 ${won(p.shipping.remoteSurcharge)} 추가` : ""}`;
  const reward = p.reward
    ? [p.reward.card && `카드 ${won(Math.floor((unit * p.reward.card.rate) / 100))} (${p.reward.card.rate}%)`, p.reward.bankTransfer && `무통장 ${won(Math.floor((unit * p.reward.bankTransfer.rate) / 100))} (${p.reward.bankTransfer.rate}%)`].filter(Boolean).join(" · ")
    : null;

  return (
    <article className="pd" aria-label={p.name}>
      {p.isLive && <LiveNotice slug={slug} />}
      <ShopBack fallback={`/shop/${encodeURIComponent(slug)}/products`} label="목록" />
      {crumb.length > 0 && (
        <nav className="pd-crumb" aria-label="상품 경로">
          <Link href={`${base}/products`}>전체 상품</Link>
          {crumb.map((c) => (
            <span key={c.id}>
              {" › "}
              <Link href={`${base}/products?category=${c.id}`}>{c.name}</Link>
            </span>
          ))}
        </nav>
      )}
      <div className="pd-top">
        <div className="pd-gallery">
          <div className="pd-hero">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {hero && <img src={hero.url} alt={p.name} />}
            {p.soldOut && <span className="pc-out" role="img" aria-label="품절">SOLD OUT</span>}
          </div>
          {p.images.length > 1 && (
            <div className="pd-thumbs" role="group" aria-label="상품 사진">
              {p.images.map((im, i) => (
                <button key={im.id} type="button" aria-label={`사진 ${i + 1}`} aria-current={i === photo ? "true" : undefined} onClick={() => setPhoto(i)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.url} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pd-info">
          <h1>{p.name}</h1>
          {p.description && <p className="pd-desc">{p.description}</p>}
          <table className="pd-form">
            <tbody>
              <tr>
                <th scope="row">판매가</th>
                <td>
                  {p.salePrice !== null ? (
                    <>
                      <b className="pd-price">
                        {rate > 0 && <span className="pc-rate">{rate}% </span>}
                        {won(p.salePrice)}
                      </b>{" "}
                      <del>{won(p.price)}</del>
                      {p.event && <span className="pd-hint">이벤트 할인{p.event.endsAt ? ` · ${kstDate(p.event.endsAt)}까지` : ""}</span>}
                    </>
                  ) : (
                    <b className="pd-price">{won(p.price)}</b>
                  )}
                </td>
              </tr>
              <CouponRow slug={slug} loggedIn={loggedIn} />
              {reward && (
                <tr>
                  <th scope="row">예상 적립</th>
                  <td>{reward}</td>
                </tr>
              )}
              <tr>
                <th scope="row">배송비</th>
                <td>{ship}</td>
              </tr>
              <tr>
                <th scope="row">
                  <label htmlFor="pd-option">옵션</label>
                </th>
                <td>
                  <select id="pd-option" className="inp pd-select" value={optionId} onChange={(e) => pickOption(e.target.value)} disabled={p.options.length === 0}>
                    {p.options.map((o) => (
                      <option key={o.id} value={o.id} disabled={o.soldOut}>
                        {o.name} · {o.soldOut ? "품절" : won(o.salePrice ?? o.price)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
              {option?.stockLeft != null && (
                <tr>
                  <th scope="row">재고</th>
                  <td>{option.stockLeft}개 남았어요</td>
                </tr>
              )}
              <tr>
                <th scope="row">수량</th>
                <td>
                  <span className="cart-qty">
                    <button type="button" aria-label="수량 줄이기" disabled={qty <= 1} onClick={() => changeQty(qty - 1)}>
                      −
                    </button>
                    <span aria-label={`수량 ${qty}개`}>{qty}</span>
                    <button type="button" aria-label="수량 늘리기" disabled={out || qty >= QTY_MAX} onClick={() => changeQty(qty + 1)}>
                      +
                    </button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>

          <div className="pd-sum">
            <div>
              <span>
                {option ? `${option.name} × ${qty}` : "옵션을 골라 주세요"}
              </span>
              <span>{won(unit * qty)}</span>
            </div>
            <div className="pd-total">
              <span>총 상품 금액</span>
              <b>{won(unit * qty)}</b>
            </div>
          </div>

          <div className="pd-actions">
            {out ? (
              <>
                <button type="button" className="btn btn-lg btn-out" disabled>
                  품절됐어요
                </button>
                {p.soldOut && (
                  <button type="button" className="btn btn-lg" aria-pressed={restock} disabled={busy} onClick={onRestock}>
                    {restock ? "재입고 알림 취소" : "재입고 알림 받기"}
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="btn btn-lg btn-out" disabled={busy} onClick={onCart}>
                장바구니
              </button>
            )}
            <button type="button" className="btn btn-lg btn-out pd-wish" aria-pressed={wished} aria-label={wished ? "찜 빼기" : "찜하기"} disabled={busy} onClick={onWish}>
              {wished ? "♥" : "♡"}
            </button>
            <button type="button" className="btn btn-lg btn-out pd-share" onClick={() => void onShare()}>
              공유
            </button>
            {!out && (
              <button type="button" className="btn btn-lg" disabled={busy} onClick={onBuy}>
                구매하기
              </button>
            )}
          </div>
          {msg && (
            <p className={msg.ok ? "pd-msg" : "pd-msg pd-err"} role="status">
              {msg.text}
              {msg.cart && (
                <>
                  {" "}
                  <Link href={`${base}/cart`}>장바구니 보기</Link>
                </>
              )}
            </p>
          )}
        </div>
      </div>

      <DetailTabs />

      <section className="pd-detail" id="pd-info" aria-label="상세 정보">
        <h2>상세 정보</h2>
        {p.detail.length === 0 ? (
          <p className="shop-empty">상세 정보가 아직 없어요.</p>
        ) : (
          p.detail.map((b, i) =>
            b.type === "text" ? (
              <p key={i} className="pd-text">
                {b.text}
              </p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} className="pd-dimg" src={b.url} width={b.width} height={b.height} alt="" loading="lazy" />
            ),
          )
        )}
      </section>

      <ProductReviews slug={slug} productId={p.id} />

      <ProductInquiries slug={slug} productId={p.id} loggedIn={loggedIn} onNeedLogin={() => setNeedLogin(true)} />

      <RecommendedProducts slug={slug} productId={p.id} />

      <RecentProducts slug={slug} current={{ id: p.id, name: p.name, price: p.price, salePrice: p.salePrice, soldOut: p.soldOut, thumbnailUrl: p.images[0]?.url ?? null }} />

      {needLogin && (
        <ShopModal
          title="로그인이 필요해요"
          onClose={() => setNeedLogin(false)}
          footer={
            <>
              <Link className="btn" href={`${base}/login?next=${encodeURIComponent(here)}`}>
                로그인
              </Link>
              <button type="button" className="btn btn-out" onClick={() => setNeedLogin(false)}>
                둘러보기
              </button>
            </>
          }
        >
          <p>회원만 주문할 수 있어요. 가입은 1분이면 돼요.</p>
        </ShopModal>
      )}
    </article>
  );
}
