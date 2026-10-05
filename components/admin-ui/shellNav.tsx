"use client";

import Link from "next/link";
import { createContext, useContext } from "react";

// 셸(파트너스·마스터 관리자 틀)이 PageHead에 넘기는 화면 이동 정보.
// backHref: 화면 ← 버튼이 갈 부모 주소(없으면 ← 없음 = 메뉴로 바로 여는 화면·홈). tabs: 통합 화면의 위쪽 탭(2개 이상일 때만 채운다).
export type ShellTab = { label: string; href: string; on: boolean };
export type ShellNav = { backHref: string | null; tabs: ShellTab[] };

const ShellNavCtx = createContext<ShellNav>({ backHref: null, tabs: [] });
export const ShellNavProvider = ShellNavCtx.Provider;
export const useShellNav = (): ShellNav => useContext(ShellNavCtx);

// 통합 화면 탭 줄(.rtabs). 같은 메뉴 항목의 화면이 2개 이상일 때만 그린다.
// PageHead가 머리 바로 아래에 붙이고, PageHead를 아직 안 쓰는 화면은 셸 경로 줄 아래(.rtabs-top)에 대신 붙는다(둘 중 하나만 보임, styles/seller.css)
export function RouteTabs({ className }: { className?: string }) {
  const { tabs } = useShellNav();
  if (tabs.length < 2) return null;
  return (
    <nav className={`rtabs${className ? ` ${className}` : ""}`} aria-label="화면 탭">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className={t.on ? "on" : undefined} aria-current={t.on ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
