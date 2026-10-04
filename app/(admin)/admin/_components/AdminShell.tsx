"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { adminApi, type AdminMe } from "./api";

// 마스터 관리자 공통 틀(최소): 파트너스 관리자와 같은 왼쪽 메뉴 + 상단 바 모양. 지금은 사이트 설정만 있다.
const NAV = [{ h: "사이트 설정" }, { label: "파비콘 · 공유 카드", href: "/admin/settings/branding" }] as const;

const ROLE_LABEL: Record<AdminMe["role"], string> = { SUPER_ADMIN: "최고관리자", OPERATIONS: "운영", CS: "고객 지원", READ_ONLY: "조회 전용" };

type ShellCtx = { me: AdminMe; openNav: () => void };
const Ctx = createContext<ShellCtx | null>(null);

export function useAdmin(): ShellCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("AdminShell 안에서만 사용합니다");
  return v;
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [failed, setFailed] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
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

  useEffect(() => setNavOpen(false), [pathname]);

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

  return (
    <Ctx.Provider value={{ me, openNav: () => setNavOpen(true) }}>
      <div className={`shell${navOpen ? " nav-open" : ""}`}>
        <aside className="side" aria-label="마스터 관리자 메뉴">
          <Link className="logo" href="/admin/settings/branding" style={{ padding: "6px 12px 14px", fontSize: 18 }}>
            <span className="logo-sym" />
            <span className="logo-word" />
            <span className="t-c1 c-alt" style={{ marginLeft: 4 }}>
              마스터
            </span>
          </Link>
          {NAV.map((n, i) =>
            "h" in n ? (
              <span key={i} className="nav-h">
                {n.h}
              </span>
            ) : (
              <Link key={i} className={`nav-i${pathname.startsWith(n.href) ? " on" : ""}`} href={n.href}>
                {n.label}
              </Link>
            ),
          )}
          <button className="btn btn-sm btn-ghost side-logout" type="button" onClick={() => void logout()}>
            로그아웃
          </button>
          {logoutError && (
            <span className="err side-logout-err" role="alert">
              로그아웃하지 못했습니다. 다시 시도해 주십시오.
            </span>
          )}
        </aside>
        <button className="nav-dim" type="button" aria-label="메뉴 닫기" onClick={() => setNavOpen(false)} />
        <div className="col shell-body">{children}</div>
      </div>
    </Ctx.Provider>
  );
}

export function AdminTopbar({ crumb, children }: { crumb: string; children?: React.ReactNode }) {
  const { me, openNav } = useAdmin();
  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" type="button" aria-label="메뉴 열기" onClick={openNav}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <span className="crumb ell">{crumb}</span>
      <div className="row tb-actions">
        {children}
        <span className="btn btn-sm btn-ghost tb-account" title={me.email}>
          {me.name} · {ROLE_LABEL[me.role]}
        </span>
      </div>
    </header>
  );
}
