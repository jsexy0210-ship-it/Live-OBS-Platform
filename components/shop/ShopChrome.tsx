"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ShopLogo from "./ShopLogo";

type Props = { slug: string; shopName: string; loggedIn: boolean };

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
};

// 구매자 쇼핑몰 머리(띠·로고·검색·장바구니·카테고리)와 휴대폰 카테고리 서랍·아래 고정 바. 상품 분류(카테고리)가 생기면 「전체 상품」 뒤에 붙인다.
export default function ShopChrome({ slug, shopName, loggedIn }: Props) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = usePathname() ?? "";
  const [drawer, setDrawer] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const here = (href: string) => (path === href ? ("page" as const) : undefined);

  useEffect(() => setDrawer(false), [path]);
  useEffect(() => {
    if (!drawer) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  async function logout() {
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
      <Link href={`${base}/signup`}>회원가입</Link>
    </>
  );
  const cats = [{ href: `${base}/products`, label: "전체 상품" }];

  return (
    <>
      <header className="shop-head">
        <div className="shop-util">
          <div className="shop-wrap">
            {account}
            <Link href={`${base}/orders`}>주문 조회</Link>
            <Link href={`${base}/help`}>고객센터</Link>
          </div>
        </div>
        <div className="shop-top">
          <div className="shop-wrap">
            <button ref={menuRef} type="button" className="shop-iconbtn shop-m" aria-label="카테고리 메뉴" aria-expanded={drawer} onClick={() => setDrawer(true)}>
              <Icon d={ICON.menu} />
            </button>
            <Link href={base} className="shop-brand">
              <ShopLogo shopName={shopName} />
              <span className="shop-name">{shopName}</span>
            </Link>
            <form className="shop-search shop-pc" role="search" action={`${base}/search`}>
              <input type="search" name="q" maxLength={50} placeholder="상품 검색" aria-label="상품 검색" />
              <button type="submit" className="shop-iconbtn" aria-label="검색">
                <Icon d={ICON.search} />
              </button>
            </form>
            <Link href={`${base}/search`} className="shop-iconbtn shop-m" aria-label="검색">
              <Icon d={ICON.search} />
            </Link>
            <Link href={`${base}/cart`} className="shop-iconbtn shop-cart" aria-label="장바구니">
              <Icon d={ICON.cart} />
            </Link>
          </div>
        </div>
        <nav className="shop-cats" aria-label="카테고리">
          <div className="shop-wrap">
            {cats.map((c) => (
              <Link key={c.href} href={c.href} aria-current={here(c.href)}>
                {c.label}
              </Link>
            ))}
          </div>
        </nav>
      </header>

      {drawer && (
        <div className="shop-drawer-bg" onClick={() => setDrawer(false)}>
          <div className="shop-drawer" role="dialog" aria-modal="true" aria-label="카테고리 메뉴" onClick={(e) => e.stopPropagation()}>
            <div className="shop-drawer-head">
              <div className="shop-drawer-account">{account}</div>
              <button
                ref={closeRef}
                type="button"
                className="shop-iconbtn"
                aria-label="메뉴 닫기"
                onClick={() => {
                  setDrawer(false);
                  menuRef.current?.focus();
                }}
              >
                <Icon d={ICON.close} />
              </button>
            </div>
            <p className="shop-drawer-title">카테고리</p>
            <nav className="shop-drawer-list" aria-label="카테고리">
              {cats.map((c) => (
                <Link key={c.href} href={c.href} aria-current={here(c.href)}>
                  {c.label}
                </Link>
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
        <button type="button" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          <Icon d={ICON.grid} />
          카테고리
        </button>
        <Link href={`${base}/search`} aria-current={here(`${base}/search`)}>
          <Icon d={ICON.search} />
          검색
        </Link>
        <Link href={`${base}/cart`} aria-current={here(`${base}/cart`)}>
          <Icon d={ICON.cart} />
          장바구니
        </Link>
        <Link href={loggedIn ? `${base}/me` : `${base}/login`} aria-current={here(`${base}/me`)}>
          <Icon d={ICON.user} />내 정보
        </Link>
      </nav>
    </>
  );
}
