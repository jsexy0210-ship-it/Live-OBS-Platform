"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../admin-ui/ConfirmDialog";
import ShopLogo from "./ShopLogo";
import ShopBack from "./ShopBack";
import "./ShopProductHeader.css";

export const CART_COUNT_EVENT = "shop-cart-count";
const badge = (n: number) => (n > 0 ? <b className="shop-badge" aria-hidden="true">{n > 99 ? "99+" : n}</b> : null);
const cartLabel = (n: number) => (n > 0 ? `장바구니 (${n}개)` : "장바구니");

type Category = { id: string; name: string; children: { id: string; name: string }[] };
type Props = { slug: string; shopName: string; loggedIn: boolean; nickname?: string | null; categories?: Category[]; signupOpen?: boolean; liveBar?: React.ReactNode };

function Icon({ d }: { d: string }) {
  return (
    <svg className="shop-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const ICON = {
  menu: "M4 6h16M4 12h16M4 18h16",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm5-2 4 4",
  cart: "M3 4h2l2.4 11h10.2L20 8H6.2M9 20.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1zm8 0a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
  home: "M4 11 12 4l8 7v9h-5v-6H9v6H4z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 8c1-4 4.5-6 8-6s7 2 8 6",
  close: "M6 6l12 12M18 6 6 18",
  heart: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z",
};

// 구매자 쇼핑몰 머리(띠·로고·검색·장바구니·카테고리)와 휴대폰 카테고리 서랍·아래 고정 바. 「전체 상품」 뒤에 쇼핑몰의 대분류 카테고리를 붙이고, 「전체 카테고리」 버튼이나 머리 줄에 마우스를 올리면(키보드 포커스도) 대분류·소분류 펼침 판이 열린다. 서랍에는 소분류까지 보인다.
export default function ShopChrome({ slug, shopName, loggedIn, nickname, categories = [], signupOpen = true, liveBar }: Props) {
  const { confirm } = useConfirm();
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = usePathname() ?? "";
  const productPrefix = `${base}/products/`;
  const productDetail = path.startsWith(productPrefix) && !!path.slice(productPrefix.length) && !path.slice(productPrefix.length).includes("/");
  const router = useRouter();
  const [drawer, setDrawer] = useState(false);
  const entryRef = useRef(false); // 서랍을 열 때 기록 한 칸을 쌓았는지(UX-11: Back으로 서랍부터 닫는다)
  const [panel, setPanel] = useState(false); // PC 카테고리 펼침(대분류 → 소분류)
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [cartCount, setCartCount] = useState(0);
  const category = useSearchParams().get("category");
  const here = (href: string) => (path === href ? ("page" as const) : undefined);
  // 카테고리 링크는 /products?category=id. 그 분류(또는 하위 분류)를 보고 있으면 현재 위치로 표시한다.
  const inCat = (c: Category) => path === `${base}/products` && !!category && (category === c.id || c.children.some((x) => x.id === category));

  useEffect(() => {
    setDrawer(false);
    setPanel(false);
    entryRef.current = false; // 링크가 아닌 이동(검색 제출 등)으로 바뀌어도 쌓아 둔 칸 표시를 되돌린다
  }, [path, category]);
  function openDrawer() {
    if (!entryRef.current) {
      window.history.pushState(null, "", window.location.href);
      entryRef.current = true;
    }
    setDrawer(true);
  }
  // 닫기(X·배경·Esc): 쌓아 둔 기록 한 칸을 되돌리면 popstate가 서랍을 닫는다
  function closeDrawer() {
    if (entryRef.current) window.history.back();
    else setDrawer(false);
  }
  useEffect(() => {
    if (!drawer) return;
    const onPop = () => {
      entryRef.current = false;
      setDrawer(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [drawer]);
  // 서랍 안 링크: 쌓아 둔 칸을 대체해서 이동하면 Back 한 번에 이전 화면으로 돌아간다
  function drawerLink(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !entryRef.current || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const href = a.getAttribute("href");
    if (!href || !href.startsWith("/")) return;
    e.preventDefault();
    entryRef.current = false;
    router.replace(href);
  }
  // 장바구니 개수 배지: 로그인했을 때만 불러오고, 장바구니 화면이 바뀐 개수를 알려 주면(CART_COUNT_EVENT) 따라간다
  useEffect(() => {
    if (!loggedIn) return;
    let live = true;
    fetch(`/api/shop/${encodeURIComponent(slug)}/cart/count`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => live && typeof d?.count === "number" && setCartCount(d.count))
      .catch(() => null);
    const on = (e: Event) => setCartCount((e as CustomEvent<number>).detail);
    window.addEventListener(CART_COUNT_EVENT, on);
    return () => {
      live = false;
      window.removeEventListener(CART_COUNT_EVENT, on);
    };
  }, [loggedIn, slug]);
  useEffect(() => {
    if (!drawer) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  async function logout() {
    if (!(await confirm({ tone: "shop", title: "로그아웃할까요?", body: "장바구니와 찜은 그대로 남아요. 다시 로그인하면 이어서 쓸 수 있어요.", confirmLabel: "로그아웃" }))) return;
    await fetch(`/api/shop/${encodeURIComponent(slug)}/auth/logout`, { method: "POST" }).catch(() => null);
    window.location.assign(base);
  }

  const account = loggedIn ? (
    <>
      <Link href={`${base}/me`}>내 정보</Link>
      <button type="button" className="shop-linkbtn" onClick={logout}>
        로그아웃
      </button>
    </>
  ) : (
    <>
      <Link href={`${base}/login`}>로그인</Link>
      {signupOpen && <Link href={`${base}/signup`}>회원가입</Link>}
    </>
  );
  const cats = [
    { href: `${base}/products`, label: "전체 상품", current: path === `${base}/products` && !category },
    ...categories.map((c) => ({ href: `${base}/products?category=${c.id}`, label: c.name, current: inCat(c), sub: c.children })),
  ];

  return (
    <>
      <header className={`shop-head${productDetail ? " shop-product-head" : ""}`}>
        {productDetail && (
          <div className="shop-product-header" aria-label="상품 상세 머리">
            <ShopBack fallback={`${base}/products`} label="목록" />
            <span className="shop-product-title">상품 상세</span>
            <div className="shop-product-links">
              <Link href={base} className="shop-iconbtn" aria-label="홈"><Icon d={ICON.home} /></Link>
              <Link href={`${base}/cart`} className="shop-iconbtn" aria-label={cartLabel(cartCount)}><Icon d={ICON.cart} />{badge(cartCount)}</Link>
            </div>
          </div>
        )}
        <div className="shop-util">
          <div className="shop-wrap">
            {account}
            <Link href={`${base}/orders`}>주문 조회</Link>
            <Link href={`${base}/help`}>고객센터</Link>
            {loggedIn && nickname && <span className="shop-util-who">{nickname} 님</span>}
          </div>
        </div>
        <div className="shop-top">
          <div className="shop-wrap">
            <button ref={menuRef} type="button" className="shop-iconbtn shop-m" aria-label="카테고리 메뉴" aria-expanded={drawer} onClick={openDrawer}>
              <Icon d={ICON.menu} />
            </button>
            <Link href={base} className="shop-brand">
              <ShopLogo shopName={shopName} />
              <span className="shop-name">{shopName}</span>
            </Link>
            <form className="shop-search shop-pc" role="search" action={`${base}/search`}>
              <input type="search" name="q" maxLength={50} placeholder="상품 검색" aria-label="상품 검색" />
              <button type="submit" className="shop-search-btn">
                검색
              </button>
            </form>
            <Link href={`${base}/search`} className="shop-iconbtn shop-m" aria-label="검색">
              <Icon d={ICON.search} />
            </Link>
            <Link href={`${base}/cart`} className="shop-iconbtn shop-cart shop-m" aria-label={cartLabel(cartCount)}>
              <Icon d={ICON.cart} />
              {badge(cartCount)}
            </Link>
            <div className="shop-hics shop-pc">
              <Link href={`${base}/wishlist`} className="shop-hic">
                <span className="shop-hic-ico">
                  <Icon d={ICON.heart} />
                </span>
                찜
              </Link>
              <Link href={`${base}/cart`} className="shop-hic">
                <span className="shop-hic-ico">
                  <Icon d={ICON.cart} />
                  {badge(cartCount)}
                </span>
                {cartLabel(cartCount)}
              </Link>
              <Link href={loggedIn ? `${base}/me` : `${base}/login`} className="shop-hic">
                <Icon d={ICON.user} />내 정보
              </Link>
            </div>
          </div>
        </div>
        {liveBar}
        <nav
          className="shop-cats"
          aria-label="카테고리"
          onMouseEnter={() => categories.length > 0 && setPanel(true)}
          onMouseLeave={() => setPanel(false)}
          onFocus={() => categories.length > 0 && setPanel(true)}
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setPanel(false)}
          onKeyDown={(e) => e.key === "Escape" && setPanel(false)}
        >
          <div className="shop-wrap">
            {categories.length > 0 && (
              <button type="button" className="shop-cats-all" aria-expanded={panel} aria-controls="shop-catpanel" onClick={() => setPanel(true)}>
                <Icon d={ICON.menu} />
                전체 카테고리
              </button>
            )}
            {cats.map((c) => (
              <Link key={c.href} href={c.href} aria-current={c.current ? "page" : undefined}>
                {c.label}
              </Link>
            ))}
            <Link href={base}>인기 카드</Link>
            <Link href={`${base}/help`}>공지 · 이용안내</Link>
          </div>
          {panel && categories.length > 0 && (
            <div id="shop-catpanel" className="shop-catpanel">
              <div className="shop-wrap">
                {categories.map((c) => (
                  <div key={c.id} className="shop-catcol">
                    <Link href={`${base}/products?category=${c.id}`} className="shop-catcol-h" aria-current={category === c.id ? "page" : undefined}>
                      {c.name}
                    </Link>
                    {c.children.map((x) => (
                      <Link key={x.id} href={`${base}/products?category=${x.id}`} aria-current={category === x.id ? "page" : undefined}>
                        {x.name}
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </nav>
        <nav className="shop-mcat" aria-label="메뉴 탭">
          <Link href={base} aria-current={here(base)}>
            홈
          </Link>
          {cats.map((c) => (
            <Link key={c.href} href={c.href} aria-current={c.current ? "page" : undefined}>
              {c.label}
            </Link>
          ))}
          <Link href={base}>인기 카드</Link>
          <Link href={`${base}/help`}>공지 · 이용안내</Link>
        </nav>
      </header>

      {drawer && (
        <div className="shop-drawer-bg" onClick={closeDrawer}>
          <div className="shop-drawer" role="dialog" aria-modal="true" aria-label="카테고리 메뉴" onClick={(e) => {
            e.stopPropagation();
            drawerLink(e);
          }}>
            <div className="shop-drawer-head">
              <div className="shop-drawer-account">{account}</div>
              <button
                ref={closeRef}
                type="button"
                className="shop-iconbtn"
                aria-label="메뉴 닫기"
                onClick={() => {
                  closeDrawer();
                  menuRef.current?.focus();
                }}
              >
                <Icon d={ICON.close} />
              </button>
            </div>
            <p className="shop-drawer-title">카테고리</p>
            <nav className="shop-drawer-list" aria-label="카테고리">
              {cats.map((c) => (
                <div key={c.href}>
                  <Link href={c.href} aria-current={c.current ? "page" : undefined}>
                    {c.label}
                  </Link>
                  {"sub" in c &&
                    c.sub.map((x) => (
                      <Link key={x.id} className="shop-drawer-child" href={`${base}/products?category=${x.id}`} aria-current={category === x.id ? "page" : undefined}>
                        {x.name}
                      </Link>
                    ))}
                </div>
              ))}
            </nav>
            <nav className="shop-drawer-list shop-drawer-sub" aria-label="쇼핑 도움">
              <Link href={`${base}/orders`}>주문 조회</Link>
              <Link href={`${base}/help`}>고객센터</Link>
            </nav>
          </div>
        </div>
      )}

      <nav className="shop-tabbar" aria-label="바로 가기">
        <Link href={base} aria-current={here(base)}>
          <Icon d={ICON.home} />홈
        </Link>
        <button type="button" aria-expanded={drawer} onClick={openDrawer}>
          <Icon d={ICON.grid} />
          카테고리
        </button>
        <Link href={`${base}/search`} aria-current={here(`${base}/search`)}>
          <Icon d={ICON.search} />
          검색
        </Link>
        <Link href={`${base}/cart`} aria-current={here(`${base}/cart`)}>
          <span className="shop-hic-ico">
            <Icon d={ICON.cart} />
            {badge(cartCount)}
          </span>
          {cartLabel(cartCount)}
        </Link>
        <Link href={loggedIn ? `${base}/me` : `${base}/login`} aria-current={here(`${base}/me`)}>
          <Icon d={ICON.user} />내 정보
        </Link>
      </nav>
    </>
  );
}
