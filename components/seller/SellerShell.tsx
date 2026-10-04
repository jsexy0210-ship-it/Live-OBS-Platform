"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLatestResponse, type ReadTicket } from "./latestResponse";
import { api, type Me } from "./api";

// 파트너스 관리자 공통 틀(업무용 관리 화면 틀, 대표님 지시 2026-10-04): 상단 고정 GNB(대분류) + 왼쪽 LNB(고른 대분류의 하위 메뉴) + 본문.
// 메뉴 묶음은 docs/IA.md SA 「메뉴 그룹」 표를 따른다. 좁은 화면에서는 GNB가 햄버거로 접히고 LNB가 서랍으로 열린다(서랍에는 전체 메뉴).
// 아직 만들지 않은 화면은 메뉴에서 흐리게 두고 누를 수 없게 한다.

// perm: 그 권한이 있어야 메뉴가 보인다. OWNER는 대표자 전용. 하위 메뉴가 모두 숨겨진 대분류는 GNB에서도 숨긴다.
type Item = { label: string; href?: string; perm?: string };
type Group = { key: string; label: string; items: Item[] };
const MENU: Group[] = [
  { key: "home", label: "홈", items: [{ label: "홈" }] },
  {
    key: "broadcast",
    label: "방송",
    items: [
      { label: "방송 대시보드", perm: "BROADCAST_RUN" },
      { label: "오버레이 편집기", perm: "OVERLAY_EDIT" },
      { label: "HIT 카드 이력", perm: "BROADCAST_RUN" },
      { label: "방송 이력", perm: "BROADCAST_RUN" },
    ],
  },
  {
    key: "order",
    label: "주문",
    items: [
      { label: "전체 주문", href: "/seller/orders", perm: "ORDER_SHIPPING" },
      { label: "입금 확인", perm: "ORDER_SHIPPING" },
      { label: "배송", perm: "ORDER_SHIPPING" },
      { label: "영수증 · 세금계산서", perm: "RECEIPT_TAX" },
    ],
  },
  {
    key: "product",
    label: "상품",
    items: [
      { label: "상품 목록", href: "/seller/products", perm: "PRODUCT_MANAGE" },
      { label: "상품 등록", href: "/seller/products/new", perm: "PRODUCT_MANAGE" },
      { label: "재고 관리", href: "/seller/products/stock", perm: "PRODUCT_MANAGE" },
    ],
  },
  {
    key: "member",
    label: "회원",
    items: [
      { label: "회원", perm: "MEMBER_POINTS" },
      { label: "적립금", href: "/seller/rewards", perm: "MEMBER_POINTS" },
      { label: "구매 제한", perm: "MEMBER_POINTS" },
      { label: "구매자 문의", perm: "INQUIRY_REPLY" },
    ],
  },
  // 쿠폰: 집계 조회는 파트너스 계정 누구나, 만들기·지급은 적립금(MEMBER_POINTS) 권한(화면에서 막음)
  { key: "promotion", label: "프로모션", items: [{ label: "쿠폰", href: "/seller/coupons" }] },
  { key: "design", label: "디자인", items: [{ label: "배너 · 팝업", href: "/seller/banners" }] },
  { key: "stats", label: "통계", items: [{ label: "통계", href: "/seller/stats", perm: "SALES_VIEW" }] },
  {
    key: "settings",
    label: "쇼핑몰 설정",
    items: [
      { label: "쇼핑몰 정보", href: "/seller/settings/shop" },
      { label: "주문 설정", href: "/seller/settings/order", perm: "SHOP_SETTINGS" },
      { label: "배송 설정", href: "/seller/settings/shipping", perm: "SHOP_SETTINGS" },
      // 회원 정책: IA 표에는 없지만 이미 있는 화면이라 쇼핑몰 설정 안에 둔다
      { label: "회원 정책", href: "/seller/settings/member", perm: "MEMBER_POINTS" },
      { label: "공유 설정", href: "/seller/settings/share", perm: "SHOP_SETTINGS" },
      { label: "결제(PG) 연결", perm: "OWNER" },
      { label: "주문자 알림", perm: "SHOP_SETTINGS" },
      { label: "직원 계정", href: "/seller/staff", perm: "OWNER" },
      { label: "구독 · 결제", perm: "OWNER" },
    ],
  },
];

// 지금 주소에 맞는 메뉴: 주소 앞부분이 가장 길게 맞는 메뉴(상품 상세 → 상품 목록, 이벤트 팝업 → 배너 · 팝업)
function findActive(groups: Group[], pathname: string): { group: Group; item: Item } | null {
  let best: { group: Group; item: Item } | null = null;
  for (const group of groups)
    for (const item of group.items)
      if (item.href && (pathname === item.href || pathname.startsWith(`${item.href}/`)) && (!best || item.href.length > best.item.href!.length)) best = { group, item };
  return best;
}

// loc: 지금 화면의 대분류 · 메뉴 이름(본문 위 경로 줄에 쓴다)
type ShellCtx = { me: Me; trialDaysLeft: number | null; openNav: () => void; can: (perm: string) => boolean; loc: { group: string; item: string; exact: boolean } | null };
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
  // GNB에서 고른 대분류(화면을 옮기면 지금 화면의 대분류로 돌아간다)
  const [picked, setPicked] = useState<string | null>(null);

  const lastRead = useRef(0);
  // /me 다시 읽기 반영 규칙(latestResponse.ts): 나중에 보낸 요청의 성공만 반영하고, 실패가 앞선 성공을 버리지 않는다.
  // 반영할 때 파생 값(남은 체험 일수)도 함께 계산한다: 처음 읽기·다시 읽기 어느 쪽이 먼저 성공해도 같은 결과
  const meReads = useLatestResponse();
  const applyMe = (t: ReadTicket, data: Me) => {
    if (meReads.accept(t) !== "apply") return;
    setFailed(false);
    setMe(data);
    // 체험 중이면 /me가 끝나는 시각을 준다(대표자·직원 모두)
    setTrialDaysLeft(data.access === "trial" && data.trialEndsAt ? Math.max(0, Math.ceil((new Date(data.trialEndsAt).getTime() - Date.now()) / 86_400_000)) : null);
  };
  const load = useCallback(async () => {
    lastRead.current = Date.now();
    setFailed(false);
    const t = meReads.next();
    const r = await api<Me>("/api/seller/me");
    if (!r.ok) {
      if (r.status === 401) router.replace(`/seller/login?next=${encodeURIComponent(pathname)}`);
      // 아직 한 번도 그리지 못했으면 다시 시도 화면을 보인다(이미 그린 화면은 그대로 둔다)
      else if (!meReads.hasApplied() && meReads.failMatters(t)) setFailed(true);
      return;
    }
    applyMe(t, r.data);
  }, [router, pathname]);

  useEffect(() => {
    void load();
    // 처음 한 번 불러온다
  }, []);

  // 화면을 옮길 때마다 권한·이용 상태를 조용히 다시 읽는다(대표자가 직원 권한을 바꾸면 다음 화면부터 메뉴에 반영).
  // 로딩 화면은 띄우지 않고, 실패하면 지금 값을 그대로 둔다(401이면 공통 api()가 로그인으로 보낸다)
  // 창으로 돌아올 때(포커스·화면이 다시 보일 때)도 다시 읽는다: 권한이 하나도 없는 직원은 옮길 화면이 없어 경로로는 새로 읽지 못한다.
  // 짧은 간격으로 겹치면(포커스와 visibilitychange가 함께 오는 경우 등) 한 번만 읽는다
  const refresh = useCallback(() => {
    lastRead.current = Date.now();
    const t = meReads.next();
    void api<Me>("/api/seller/me").then((r) => {
      if (r.ok) applyMe(t, r.data);
    });
  }, []);
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    refresh();
  }, [pathname, refresh]);
  useEffect(() => {
    // 마지막으로 읽은 지 1초 안에 돌아오면 바로 읽지 않고 1초가 되는 때로 한 번 미룬다(버리면 그사이 바뀐 권한을 다음 포커스까지 못 본다)
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const onBack = () => {
      if (document.visibilityState !== "visible") return;
      const wait = 1000 - (Date.now() - lastRead.current);
      if (wait <= 0) return refresh();
      if (trailing) return;
      trailing = setTimeout(() => {
        trailing = null;
        refresh();
      }, wait);
    };
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      if (trailing) clearTimeout(trailing);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [refresh]);

  useEffect(() => {
    setNavOpen(false);
    setPicked(null);
  }, [pathname]);

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
        <span className="t">화면을 불러오지 못했습니다</span>
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
  // 권한이 없는 메뉴는 숨기고, 하위 메뉴가 하나도 안 남은 대분류도 숨긴다
  const menu = MENU.map((g) => ({ ...g, items: g.items.filter((n) => !n.perm || can(n.perm)) })).filter((g) => g.items.length > 0);
  const active = findActive(menu, pathname);
  const shown = menu.find((g) => g.key === picked) ?? active?.group ?? menu[0];
  const loc = active ? { group: active.group.label, item: active.item.label, exact: pathname === active.item.href } : null;

  const utilities = (
    <>
      <a className="util-i" href={`/shop/${me.shop.slug}`} target="_blank" rel="noreferrer">
        쇼핑몰 바로가기
      </a>
      <a className="util-i off" aria-disabled="true" title="준비 중입니다">
        공지 · 문의
      </a>
      <a className="util-i off" aria-disabled="true" title="준비 중입니다">
        도우미
      </a>
      <a className="util-i off" aria-disabled="true" title="준비 중입니다">
        내 계정
      </a>
      <button className="util-i util-btn" type="button" onClick={() => void logout()}>
        로그아웃
      </button>
    </>
  );

  return (
    <Ctx.Provider value={{ me, trialDaysLeft, openNav: () => setNavOpen(true), can, loc }}>
      <div className={`cs${navOpen ? " nav-open" : ""}`}>
        <header className="gnb">
          <button className="gnb-menu" type="button" aria-label="메뉴 열기" onClick={() => setNavOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <Link className="logo gnb-logo" href="/seller/products">
            <span className="logo-sym" />
            <span className="logo-word" />
            <span className="gnb-sub">파트너스</span>
          </Link>
          <nav className="gnb-nav" aria-label="주 메뉴">
            {menu.map((g) => {
              const first = g.items.find((n) => n.href)?.href;
              const cls = `gnb-i${g.key === shown.key ? " on" : ""}`;
              return first ? (
                <Link key={g.key} className={cls} href={first} onClick={() => setPicked(null)}>
                  {g.label}
                </Link>
              ) : (
                <button key={g.key} className={cls} type="button" aria-pressed={g.key === shown.key} onClick={() => setPicked(g.key)}>
                  {g.label}
                </button>
              );
            })}
          </nav>
          <div className="gnb-util">
            <span className="gnb-shop ell" title={`${me.user.name} · ${me.user.email}`}>
              {me.shop.name}
            </span>
            <span className="util-desk">{utilities}</span>
          </div>
        </header>
        {logoutError && (
          <div className="msg msg-neg logout-err" role="alert">
            로그아웃하지 못했습니다. 다시 시도해 주십시오
          </div>
        )}
        <div className="cs-wrap">
          <aside className="lnb" aria-label="파트너스 메뉴">
            {menu.map((g) => (
              <section key={g.key} className={`lnb-sec${g.key === shown.key ? " on" : ""}`}>
                <strong className="lnb-h">{g.label}</strong>
                {g.items.map((n) =>
                  n.href ? (
                    <Link
                      key={n.label}
                      className={`lnb-i${active?.item === n ? " on" : ""}`}
                      href={n.href}
                      aria-current={active?.item === n ? "page" : undefined}
                      onClick={() => setNavOpen(false)}
                    >
                      {n.label}
                    </Link>
                  ) : (
                    <a key={n.label} className="lnb-i off" aria-disabled="true" title="준비 중입니다">
                      {n.label}
                    </a>
                  ),
                )}
              </section>
            ))}
            <div className="lnb-util">{utilities}</div>
          </aside>
          <button className="cs-dim" type="button" aria-label="메뉴 닫기" onClick={() => setNavOpen(false)} />
          <div className="col cs-body">{children}</div>
        </div>
      </div>
    </Ctx.Provider>
  );
}

// 화면마다 본문 위에 경로 줄(대분류 › 메뉴 · 오른쪽 버튼)을 넣고, 그 아래에 이용 상태 배너를 붙인다.
// crumb: 예전 경로 문구. 경로는 메뉴 구조에서 만들고, 하위 화면(주문 상세·이벤트 팝업 등)이면 crumb 마지막 칸을 덧붙인다.
export function Topbar({ crumb, badge, children }: { crumb: string; badge?: React.ReactNode; children?: React.ReactNode }) {
  const { loc } = useSeller();
  const parts = crumb.split("›").map((p) => p.trim());
  const last = parts[parts.length - 1];
  const path = loc ? [loc.group, loc.item] : parts;
  if (loc && !loc.exact && parts.length > 2 && last !== loc.item && last !== loc.group) path.push(last);
  // 대분류와 메뉴 이름이 같으면(통계 › 통계) 한 번만
  const shownPath = path.filter((p, i) => i === 0 || p !== path[i - 1]);
  return (
    <>
      <div className="loc-bar">
        <span className="crumb ell">
          {shownPath.map((p, i) => (
            <span key={i} className={i === shownPath.length - 1 ? "crumb-now" : undefined}>
              {i > 0 && <span className="crumb-sep" aria-hidden="true">›</span>}
              {p}
            </span>
          ))}
        </span>
        {badge}
        <div className="row tb-actions">{children}</div>
      </div>
      <AccessBanner />
    </>
  );
}

function AccessBanner() {
  const { me, trialDaysLeft } = useSeller();
  if (me.access === "trial") {
    return (
      <div className="msg msg-info access-banner" role="status">
        <b>{trialDaysLeft === null ? "체험 중입니다" : trialDaysLeft === 0 ? "체험이 오늘 끝납니다" : `체험이 ${trialDaysLeft}일 남았습니다`}</b>
        <span>체험이 끝나기 전에 구독하면 그대로 이어서 사용할 수 있습니다</span>
      </div>
    );
  }
  if (me.access === "grace") {
    return (
      <div className="msg msg-cau access-banner" role="status">
        <b>구독료 결제가 되지 않았습니다</b>
        <span>결제 카드를 확인해 주십시오. 며칠 안에 결제되지 않으면 새 판매가 중지됩니다</span>
      </div>
    );
  }
  if (me.access === "expired") {
    return (
      <div className="msg msg-neg access-banner" role="alert">
        <b>이용 기간이 끝났습니다</b>
        <span>지금은 상품 등록·수정과 새 판매가 중지되어 있습니다. {me.isOwner ? "구독하면 바로 다시 사용할 수 있습니다" : "대표자에게 구독을 요청해 주십시오"}</span>
      </div>
    );
  }
  return null;
}
