"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { useSeller } from "./SellerShell";

// 쇼핑몰 설정 안의 화면 이동(쇼핑몰 정보 · 배송비 정책 · 주문 설정 · 회원 정책 · 공유 미리보기)
// perm: 그 탭 화면을 볼 수 있는 권한(각 화면 조회 API와 같은 기준). 없으면 모든 직원이 본다. 볼 수 없는 탭은 그리지 않는다.
const TABS: { href: string; label: string; perm?: string }[] = [
  { href: "/seller/settings/shop", label: "쇼핑몰 정보" },
  { href: "/seller/settings/shipping", label: "배송비 정책", perm: "SHOP_SETTINGS" },
  { href: "/seller/settings/order", label: "주문 설정", perm: "SHOP_SETTINGS" },
  { href: "/seller/settings/member", label: "회원 정책", perm: "MEMBER_POINTS" },
  { href: "/seller/settings/share", label: "공유 미리보기", perm: "SHOP_SETTINGS" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  const { can } = useSeller();
  // 좁은 화면에서 지금 탭이 탭 줄 밖에 있으면 탭 줄만 가로로 넘겨 보이게 한다(화면은 세로로 움직이지 않게 scrollLeft만 바꾼다)
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = nav.current;
    const on = el?.querySelector<HTMLElement>("[aria-current=page]");
    if (!el || !on) return;
    const left = on.offsetLeft - el.offsetLeft;
    if (left < el.scrollLeft || left + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = left + on.offsetWidth - el.clientWidth;
  }, [pathname]);
  return (
    <nav className="tabs settings-tabs" aria-label="쇼핑몰 설정" ref={nav}>
      {TABS.filter((t) => !t.perm || can(t.perm)).map((t) => (
        <Link key={t.href} href={t.href} className={`tab${pathname === t.href ? " on" : ""}`} aria-current={pathname === t.href ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
