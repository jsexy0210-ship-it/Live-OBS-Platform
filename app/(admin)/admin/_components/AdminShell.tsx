"use client";

import Link from "next/link";
import { GlobalSearch, NotificationBell } from "../../../../components/admin-ui/GnbTools";
import { ConfirmProvider } from "../../../../components/admin-ui/ConfirmDialog";
import { ShellNavProvider, type ShellNav } from "../../../../components/admin-ui/shellNav";
import { useWholeDateClick } from "../../../../components/admin-ui/useWholeDateClick";
import { usePathname, useRouter } from "next/navigation";
import { createContext, Fragment, useContext, useEffect, useState } from "react";
import { adminApi, type AdminMe } from "./api";
import { itemAllowed, routeNav, visibleAdminMenu } from "./menu";
import { useEllipsisTitle } from "../../../../components/admin-ui/useEllipsisTitle";

// 마스터 관리자 공통 틀(업무용 관리 화면 틀, 대표님 지시 2026-10-04): 상단 청록 GNB(대분류) + 왼쪽 LNB(고른 대분류의 하위 메뉴) + 본문.
// 파트너스 관리자 틀(.cs·.gnb·.lnb·.loc-bar)을 그대로 쓰고 색만 admin.css에서 마스터 청록으로 바꾼다. 좁은 화면에서는 GNB가 햄버거로 접히고 LNB가 서랍(전체 메뉴)으로 열린다.
const ROLE_LABEL: Record<AdminMe["role"], string> = { SUPER_ADMIN: "최고관리자", OPERATIONS: "운영", CS: "고객 지원", READ_ONLY: "조회 전용" };

// groupHref·itemHref: 경로 줄에서 앞 항목을 눌러 갈 주소(대분류의 첫 화면·메뉴 항목의 화면)
type ShellCtx = { me: AdminMe; openNav: () => void; loc: { group: string; item: string; groupHref?: string; itemHref?: string } | null };
const Ctx = createContext<ShellCtx | null>(null);

export function useAdmin(): ShellCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("AdminShell 안에서만 사용합니다");
  return v;
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  useEllipsisTitle();
  // 날짜 칸 어디를 눌러도 달력이 열린다(화면마다 따로 걸지 않는다)
  useWholeDateClick();
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [failed, setFailed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  // GNB에서 고른 대분류(화면을 옮기면 지금 화면의 대분류로 돌아간다)
  const [picked, setPicked] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState(false);

  const load = async () => {
    setFailed(false);
    const r = await adminApi<AdminMe>("/api/admin/me");
    if (r.ok) setMe(r.data);
    else if (r.status !== 401) setFailed(true);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setNavOpen(false);
    setPicked(null);
  }, [pathname]);

  const logout = async () => {
    setLogoutError(false);
    const r = await adminApi("/api/admin/auth/logout", { method: "POST" });
    if (r.ok) router.replace("/admin/login");
    else setLogoutError(true);
  };

  if (failed) {
    return (
      <div className="st" style={{ minHeight: "100vh", borderRadius: 0 }}>
        <div className="st-ic neg">!</div>
        <span className="t">화면을 불러오지 못했습니다.</span>
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

  const menu = visibleAdminMenu(me.role);
  const route = routeNav(pathname);
  const active = route && menu.some((g) => g.key === route.group.key) ? route : null;
  const shown = menu.find((g) => g.key === picked) ?? menu.find((g) => g.key === active?.group.key) ?? menu[0];
  const shownGroup = route ? menu.find((g) => g.key === route.group.key) : undefined;
  const loc = route ? { group: route.group.label, item: route.item.label, groupHref: shownGroup?.items[0]?.href, itemHref: route.item.href } : null;
  // 화면 ←(PageHead가 읽는다): 메뉴로 바로 여는 화면에는 없고, 상세·등록 같은 하위 화면에는 그 메뉴 화면이 부모
  const shellNav: ShellNav = { backHref: route && pathname !== route.item.href ? route.item.href : null, tabs: [] };

  const utilities = (
    <>
      <Link className="util-i" href="/admin/notifications" onClick={() => setNavOpen(false)}>
        알림 센터
      </Link>
      <Link className="util-i" href="/admin/account" onClick={() => setNavOpen(false)}>
        내 계정
      </Link>
      <button className="util-i util-btn" type="button" onClick={() => void logout()}>
        로그아웃
      </button>
    </>
  );

  return (
    <Ctx.Provider value={{ me, openNav: () => setNavOpen(true), loc }}>
      <ShellNavProvider value={shellNav}>
      <ConfirmProvider>
      <div className={`cs${navOpen ? " nav-open" : ""}`}>
        <header className="gnb">
          <button className="gnb-menu" type="button" aria-label="메뉴 열기" onClick={() => setNavOpen(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <Link className="logo gnb-logo" href="/admin">
            <span className="logo-sym" />
            <span className="logo-word" />
            <span className="gnb-sub">마스터 관리자</span>
          </Link>
          <nav className="gnb-nav" aria-label="주 메뉴">
            {menu.map((g) => (
              <Link key={g.key} className={`gnb-i${g.key === shown.key ? " on" : ""}`} href={g.items[0].href} onClick={() => setPicked(null)}>
                {g.label}
              </Link>
            ))}
          </nav>
          <div className="gnb-util">
            <span className="gnb-shop ell" title={me.email}>
              {me.name} · {ROLE_LABEL[me.role]}
            </span>
            <GlobalSearch scope="admin" />
            <NotificationBell scope="admin" allHref="/admin/notifications" />
            <span className="util-desk">{utilities}</span>
          </div>
        </header>
        {logoutError && (
          <div className="msg msg-neg logout-err" role="alert">
            로그아웃하지 못했습니다. 다시 시도해 주십시오.
          </div>
        )}
        <div className="cs-wrap">
          <aside className="lnb" aria-label="마스터 관리자 메뉴">
            {menu.map((g) => (
              <section key={g.key} className={`lnb-sec${g.key === shown.key ? " on" : ""}`}>
                <strong className="lnb-h">{g.label}</strong>
                {g.items.map((n, i) => (
                  <Fragment key={n.href}>
                    {n.sub && n.sub !== g.items[i - 1]?.sub && <span className="lnb-sub">{n.sub}</span>}
                    <Link className={`lnb-i${active?.item === n ? " on" : ""}`} href={n.href} aria-current={active?.item === n ? "page" : undefined} onClick={() => setNavOpen(false)}>
                      {n.label}
                    </Link>
                  </Fragment>
                ))}
              </section>
            ))}
            <div className="lnb-util">{utilities}</div>
          </aside>
          <button className="cs-dim" type="button" aria-label="메뉴 닫기" onClick={() => setNavOpen(false)} />
          <div className="col cs-body">{route && !itemAllowed(me.role, route.item) ? <NoAccess /> : children}</div>
        </div>
      </div>
      </ConfirmProvider>
      </ShellNavProvider>
    </Ctx.Provider>
  );
}

// 본문 위 경로 줄(대분류 › 메뉴). 메뉴에 없는 화면이면 crumb 문구를 쓴다
export function AdminTopbar({ crumb, children }: { crumb: string; children?: React.ReactNode }) {
  const { loc } = useAdmin();
  const parts = crumb.split("›").map((p) => p.trim());
  const last = parts[parts.length - 1];
  // 하위 화면(상세 등)이면 메뉴 경로 뒤에 crumb 마지막 칸을 덧붙인다
  const raw = loc
    ? loc.group === loc.item
      ? [{ t: loc.item, href: loc.itemHref }]
      : [
          { t: loc.group, href: loc.groupHref },
          { t: loc.item, href: loc.itemHref },
        ]
    : parts.map((t) => ({ t, href: undefined as string | undefined }));
  if (loc && parts.length > 2 && last !== loc.item && last !== loc.group) raw.push({ t: last, href: undefined });
  const path = raw;
  return (
    <div className="loc-bar">
      <span className="crumb ell">
        {path.map((p, i) => (
          <span key={i} className={i === path.length - 1 ? "crumb-now" : undefined}>
            {i > 0 && (
              <span className="crumb-sep" aria-hidden="true">
                ›
              </span>
            )}
            {p.href && i < path.length - 1 ? (
              <Link className="crumb-link" href={p.href}>
                {p.t}
              </Link>
            ) : (
              p.t
            )}
          </span>
        ))}
      </span>
      <div className="row tb-actions">{children}</div>
    </div>
  );
}

// 화면이 아직 없는 메뉴: 한 줄 안내
export function ComingSoon() {
  return (
    <>
      <AdminTopbar crumb="준비 중" />
      <main className="main">
        <div className="card st" style={{ boxShadow: "none" }} data-testid="admin-coming-soon">
          <span className="t">준비 중입니다</span>
        </div>
      </main>
    </>
  );
}

// 그 역할이 못 보는 메뉴 주소로 직접 들어온 경우(화면은 그리지 않는다)
function NoAccess() {
  return (
    <>
      <AdminTopbar crumb="권한 없음" />
      <main className="main">
        <div className="card st" style={{ boxShadow: "none" }} data-testid="admin-no-access">
          <span className="t">이 화면을 볼 권한이 없습니다</span>
        </div>
      </main>
    </>
  );
}
