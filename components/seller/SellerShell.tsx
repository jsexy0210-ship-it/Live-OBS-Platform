"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, type Me } from "./api";

// 판매자 관리자 공통 틀: 왼쪽 메뉴(좁은 화면에서는 서랍) + 상단 바 + 이용 상태 배너.
// 아직 만들지 않은 화면은 메뉴에서 흐리게 두고 누를 수 없게 한다.

// perm: 그 권한이 있어야 메뉴가 보인다. OWNER는 대표자 전용.
type Nav = { h: string } | { label: string; href?: string; perm?: string; match?: string };
const NAV: Nav[] = [
  { h: "홈" },
  { label: "홈" },
  { label: "통계", href: "/seller/stats/orders", match: "/seller/stats", perm: "SALES_VIEW" },
  { h: "방송" },
  { label: "방송 대시보드", perm: "BROADCAST_RUN" },
  { h: "판매" },
  { label: "상품", href: "/seller/products", perm: "PRODUCT_MANAGE" },
  { label: "주문", href: "/seller/orders", perm: "ORDER_SHIPPING" },
  { label: "입금 확인", perm: "ORDER_SHIPPING" },
  { label: "배송", perm: "ORDER_SHIPPING" },
  { label: "영수증 · 세금계산서", perm: "RECEIPT_TAX" },
  { label: "적립금", href: "/seller/rewards", perm: "MEMBER_POINTS" },
  // 쿠폰: 집계 조회는 파트너스 계정 누구나, 만들기·지급은 적립금(MEMBER_POINTS) 권한(화면에서 막음)
  { label: "쿠폰", href: "/seller/coupons" },
  { label: "회원", perm: "MEMBER_POINTS" },
  { label: "구매 제한", perm: "MEMBER_POINTS" },
  { label: "구매자 문의", perm: "INQUIRY_REPLY" },
  { h: "방송 · 오버레이" },
  { label: "오버레이 편집기", perm: "OVERLAY_EDIT" },
  { label: "HIT 카드 이력", perm: "BROADCAST_RUN" },
  { label: "방송 이력", perm: "BROADCAST_RUN" },
  { h: "설정" },
  { label: "쇼핑몰 설정", href: "/seller/settings/shipping", match: "/seller/settings", perm: "SHOP_SETTINGS" },
  { label: "배너 · 팝업", href: "/seller/banners" },
  { label: "결제(PG) 연결", perm: "OWNER" },
  { label: "주문자 알림", perm: "SHOP_SETTINGS" },
  { label: "구독 · 결제", perm: "OWNER" },
  { label: "직원 계정", perm: "OWNER" },
  { label: "공지 · 문의" },
  { label: "도우미" },
  { label: "내 계정" },
];

type ShellCtx = { me: Me; trialDaysLeft: number | null; openNav: () => void; can: (perm: string) => boolean };
const Ctx = createContext<ShellCtx | null>(null);

export function useSeller(): ShellCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("SellerShell 안에서만 써요");
  return v;
}

export function SellerShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [trialDaysLeft, setTrialDaysLeft] = useState<number | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    const r = await api<Me>("/api/seller/me");
    if (!r.ok) {
      if (r.status === 401) router.replace(`/seller/login?next=${encodeURIComponent(pathname)}`);
      else setFailed(true);
      return;
    }
    setMe(r.data);
    // 체험 중이면 /me가 끝나는 시각을 준다(대표자·직원 모두)
    if (r.data.access === "trial" && r.data.trialEndsAt) {
      const ms = new Date(r.data.trialEndsAt).getTime() - Date.now();
      setTrialDaysLeft(Math.max(0, Math.ceil(ms / 86_400_000)));
    }
  }, [router, pathname]);

  useEffect(() => {
    void load();
    // 처음 한 번만 불러온다(화면 이동마다 다시 부르지 않음)
  }, []);

  useEffect(() => setNavOpen(false), [pathname]);

  // 세션을 실제로 끊었을 때만 로그인 화면으로 보낸다. 실패하면 화면에 남아 다시 시도하게 한다(공용 기기에서 로그아웃된 줄 착각하지 않게).
  const [logoutError, setLogoutError] = useState(false);
  const logout = async () => {
    setLogoutError(false);
    const r = await api("/api/seller/auth/logout", { method: "POST" });
    if (r.ok) router.replace("/seller/login");
    else setLogoutError(true);
  };

  if (failed) {
    return (
      <div className="st" style={{ minHeight: "100vh", borderRadius: 0 }}>
        <div className="st-ic neg">!</div>
        <span className="t">화면을 불러오지 못했어요</span>
        <button className="btn btn-sm" type="button" onClick={() => void load()}>
          다시 시도
        </button>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="st" style={{ minHeight: "100vh", borderRadius: 0 }} aria-busy="true">
        <span className="spin" />
      </div>
    );
  }

  const can = (perm: string) => me.isOwner || (perm !== "OWNER" && me.permissions.includes(perm));
  // 권한이 없는 메뉴는 숨기고, 안에 메뉴가 하나도 안 남은 묶음 제목도 숨긴다
  const nav = NAV.filter((n) => !("label" in n) || !n.perm || can(n.perm)).filter((n, i, all) => !("h" in n) || (all[i + 1] !== undefined && !("h" in all[i + 1])));

  return (
    <Ctx.Provider value={{ me, trialDaysLeft, openNav: () => setNavOpen(true), can }}>
      <div className={`shell${navOpen ? " nav-open" : ""}`}>
        <aside className="side" aria-label="파트너스 메뉴">
          <Link className="logo" href="/seller/products" style={{ padding: "6px 12px 14px", fontSize: 18 }}>
            <span className="logo-sym" />
            <span className="logo-word" />
            <span className="t-c1 c-alt" style={{ marginLeft: 4 }}>
              파트너스
            </span>
          </Link>
          {nav.map((n, i) =>
            "h" in n ? (
              <span key={i} className="nav-h">
                {n.h}
              </span>
            ) : n.href ? (
              <Link key={i} className={`nav-i${pathname.startsWith(n.match ?? n.href) ? " on" : ""}`} href={n.href} onClick={() => setNavOpen(false)}>
                {n.label}
              </Link>
            ) : (
              <a key={i} className="nav-i off" aria-disabled="true" title="곧 열려요">
                {n.label}
              </a>
            ),
          )}
          <button className="btn btn-sm btn-ghost side-logout" type="button" onClick={() => void logout()}>
            로그아웃
          </button>
          {logoutError && (
            <span className="err side-logout-err" role="alert">
              로그아웃하지 못했어요. 다시 시도해 주세요
            </span>
          )}
        </aside>
        <button className="nav-dim" type="button" aria-label="메뉴 닫기" onClick={() => setNavOpen(false)} />
        <div className="col shell-body">{children}</div>
      </div>
    </Ctx.Provider>
  );
}

// 화면마다 상단 바(경로·버튼)를 넣고, 그 아래에 이용 상태 배너를 붙인다.
export function Topbar({ crumb, badge, children }: { crumb: string; badge?: React.ReactNode; children?: React.ReactNode }) {
  const { me, openNav } = useSeller();
  return (
    <>
      <header className="topbar">
        <button className="icon-btn menu-btn" type="button" aria-label="메뉴 열기" onClick={openNav}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <span className="crumb ell">{crumb}</span>
        {badge}
        <div className="row tb-actions">
          {children}
          <span className="btn btn-sm btn-ghost tb-account" title={`${me.user.name} · ${me.user.email}`}>
            {me.shop.name}
          </span>
        </div>
      </header>
      <AccessBanner />
    </>
  );
}

function AccessBanner() {
  const { me, trialDaysLeft } = useSeller();
  if (me.access === "trial") {
    return (
      <div className="msg msg-info access-banner" role="status">
        <b>{trialDaysLeft === null ? "체험 중이에요" : trialDaysLeft === 0 ? "체험이 오늘 끝나요" : `체험이 ${trialDaysLeft}일 남았어요`}</b>
        <span>체험이 끝나기 전에 구독하면 그대로 이어서 쓸 수 있어요</span>
      </div>
    );
  }
  if (me.access === "grace") {
    return (
      <div className="msg msg-cau access-banner" role="status">
        <b>구독료 결제가 안 됐어요</b>
        <span>결제 카드를 확인해 주세요. 며칠 안에 결제되지 않으면 새 판매가 멈춰요</span>
      </div>
    );
  }
  if (me.access === "expired") {
    return (
      <div className="msg msg-neg access-banner" role="alert">
        <b>이용 기간이 끝났어요</b>
        <span>지금은 상품 등록·수정과 새 판매가 멈춰 있어요. {me.isOwner ? "구독하면 바로 다시 쓸 수 있어요" : "대표자에게 구독을 요청해 주세요"}</span>
      </div>
    );
  }
  return null;
}
