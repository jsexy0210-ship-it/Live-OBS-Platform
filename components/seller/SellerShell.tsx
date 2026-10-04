"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useLatestResponse, type ReadTicket } from "./latestResponse";
import { api, PLAN_FEATURE_EVENT, type Me } from "./api";

// 판매자 관리자 공통 틀: 왼쪽 메뉴(좁은 화면에서는 서랍) + 상단 바 + 이용 상태 배너.
// 아직 만들지 않은 화면은 메뉴에서 흐리게 두고 누를 수 없게 한다.

// perm: 그 권한이 있어야 메뉴가 보인다. OWNER는 대표자 전용.
// plan: 요금제가 그 기능 권한을 줘야 메뉴가 보인다(ARCHITECTURE 4.8.0 판매자 API 분류와 같은 기준). 없으면 구독·결제처럼 항상 열린다.
//   ANY = 기능 권한이 하나라도 있을 때(ACCOUNT·ORDER_FOLLOWUP: 요금제를 낮춘 뒤에도 이미 받은 주문은 처리, 통합 첫 결제 확정 전에는 닫힘)
type PlanNeed = "ANY" | "OVERLAY" | "STORE_OPERATIONS";
type Nav = { h: string } | { label: string; href?: string; perm?: string; match?: string; plan?: PlanNeed };
const NAV: Nav[] = [
  { h: "홈" },
  { label: "홈", plan: "ANY" },
  { label: "통계", href: "/seller/stats", perm: "SALES_VIEW", plan: "STORE_OPERATIONS" },
  { h: "방송" },
  { label: "방송 대시보드", perm: "BROADCAST_RUN", plan: "OVERLAY" },
  { h: "판매" },
  { label: "상품", href: "/seller/products", perm: "PRODUCT_MANAGE", plan: "STORE_OPERATIONS" },
  { label: "주문", href: "/seller/orders", perm: "ORDER_SHIPPING", plan: "ANY" },
  { label: "입금 확인", perm: "ORDER_SHIPPING", plan: "ANY" },
  { label: "배송", perm: "ORDER_SHIPPING", plan: "ANY" },
  { label: "영수증 · 세금계산서", perm: "RECEIPT_TAX", plan: "ANY" },
  { label: "적립금", href: "/seller/rewards", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
  // 쿠폰: 집계 조회는 파트너스 계정 누구나, 만들기·지급은 적립금(MEMBER_POINTS) 권한(화면에서 막음)
  { label: "쿠폰", href: "/seller/coupons", plan: "STORE_OPERATIONS" },
  { label: "회원", perm: "MEMBER_POINTS", plan: "STORE_OPERATIONS" },
  { label: "구매 제한", perm: "MEMBER_POINTS", plan: "ANY" },
  { label: "구매자 문의", perm: "INQUIRY_REPLY", plan: "ANY" },
  { h: "방송 · 오버레이" },
  { label: "오버레이 편집기", perm: "OVERLAY_EDIT", plan: "OVERLAY" },
  { label: "HIT 카드 이력", perm: "BROADCAST_RUN", plan: "OVERLAY" },
  { label: "방송 이력", perm: "BROADCAST_RUN", plan: "OVERLAY" },
  { h: "설정" },
  { label: "쇼핑몰 설정", href: "/seller/settings/shop", match: "/seller/settings", plan: "STORE_OPERATIONS" },
  { label: "배너 · 팝업", href: "/seller/banners", plan: "STORE_OPERATIONS" },
  { label: "결제(PG) 연결", perm: "OWNER", plan: "STORE_OPERATIONS" },
  { label: "주문자 알림", perm: "SHOP_SETTINGS", plan: "STORE_OPERATIONS" },
  { label: "구독 · 결제", perm: "OWNER" },
  { label: "직원 계정", href: "/seller/staff", perm: "OWNER", plan: "ANY" },
  { label: "공지 · 문의" },
  { label: "도우미" },
  { label: "내 계정", plan: "ANY" },
];

// 주소로 바로 들어와도 요금제에 없는 화면은 안내 화면을 보인다. 메뉴 묶음과 다른 하위 화면만 따로 적는다(긴 주소가 먼저)
const ROUTE_PLAN: [string, PlanNeed][] = [["/seller/stats/broadcasts", "OVERLAY"]];
function routeNav(pathname: string) {
  return NAV.find((n): n is Extract<Nav, { label: string }> => "label" in n && !!n.href && pathname.startsWith(n.match ?? n.href));
}
// 상단 바 경로(「판매 › 주문」처럼 메뉴 묶음 › 메뉴)
function routeCrumb(pathname: string): string {
  const item = routeNav(pathname);
  if (!item) return "파트너스";
  const head = NAV.slice(0, NAV.indexOf(item)).reverse().find((n): n is { h: string } => "h" in n);
  return head && head.h !== item.label ? `${head.h} › ${item.label}` : item.label;
}
function routePlan(pathname: string): PlanNeed | undefined {
  return ROUTE_PLAN.find(([p]) => pathname.startsWith(p))?.[1] ?? routeNav(pathname)?.plan;
}

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

  useEffect(() => setNavOpen(false), [pathname]);

  // 화면이 부른 API가 403 plan_feature_required면(그사이 요금제가 바뀐 경우 등) 그 화면을 안내 화면으로 바꾸고 메뉴를 다시 읽는다
  const [planBlocked, setPlanBlocked] = useState<string | null>(null);
  useEffect(() => {
    const onBlocked = () => {
      setPlanBlocked(window.location.pathname);
      refresh();
    };
    window.addEventListener(PLAN_FEATURE_EVENT, onBlocked);
    return () => window.removeEventListener(PLAN_FEATURE_EVENT, onBlocked);
  }, [refresh]);

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
  const features = me.features ?? [];
  const hasPlan = (need?: PlanNeed) => !need || (need === "ANY" ? features.length > 0 : features.includes(need));
  // 권한·요금제 기능이 없는 메뉴는 숨기고, 안에 메뉴가 하나도 안 남은 묶음 제목도 숨긴다
  const nav = NAV.filter((n) => !("label" in n) || ((!n.perm || can(n.perm)) && hasPlan(n.plan))).filter(
    (n, i, all) => !("h" in n) || (all[i + 1] !== undefined && !("h" in all[i + 1])),
  );
  const blocked = planBlocked === pathname || !hasPlan(routePlan(pathname));
  // 안내 화면에서 갈 수 있는 첫 화면(만든 메뉴 중 지금 열리는 것)
  const nextNav = nav.find((n): n is Extract<Nav, { label: string }> => "label" in n && !!n.href && !pathname.startsWith(n.match ?? n.href));

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
              <a key={i} className="nav-i off" aria-disabled="true" title="준비 중입니다">
                {n.label}
              </a>
            ),
          )}
          <button className="btn btn-sm btn-ghost side-logout" type="button" onClick={() => void logout()}>
            로그아웃
          </button>
          {logoutError && (
            <span className="err side-logout-err" role="alert">
              로그아웃하지 못했습니다. 다시 시도해 주십시오
            </span>
          )}
        </aside>
        <button className="nav-dim" type="button" aria-label="메뉴 닫기" onClick={() => setNavOpen(false)} />
        <div className="col shell-body">
          {blocked ? <PlanFeatureRequired crumb={routeCrumb(pathname)} noFeatures={features.length === 0} next={nextNav} /> : children}
        </div>
      </div>
    </Ctx.Provider>
  );
}

// 지금 요금제에 없는 기능(서버 403 plan_feature_required, 또는 /me features에 없음)의 안내 화면
function PlanFeatureRequired({ crumb, noFeatures, next }: { crumb: string; noFeatures: boolean; next?: { label: string; href?: string } }) {
  const { me } = useSeller();
  return (
    <>
      <Topbar crumb={crumb} />
      <main className="main">
        <div className="card st" style={{ boxShadow: "none" }} data-testid="plan-feature-required">
          <div className="st-ic lock">!</div>
          <h1 className="t">지금 요금제에서 사용할 수 없는 기능입니다</h1>
          <span className="s">{noFeatures ? "구독료 첫 결제가 확정되면 사용할 수 있습니다" : "쇼핑몰 통합 요금제에서 사용할 수 있습니다"}</span>
          <span className="s">{me.isOwner ? "요금제는 구독 · 결제에서 바꿀 수 있습니다" : "요금제 변경은 대표자에게 요청해 주십시오"}</span>
          {next?.href && (
            <Link className="btn btn-sm" href={next.href}>
              {next.label} 화면으로 이동
            </Link>
          )}
        </div>
      </main>
    </>
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
