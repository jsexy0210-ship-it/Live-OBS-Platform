"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 쇼핑몰 설정 안의 화면 이동(배송비 정책 · 주문 설정 · 회원 정책)
const TABS = [
  { href: "/seller/settings/shipping", label: "배송비 정책" },
  { href: "/seller/settings/order", label: "주문 설정" },
  { href: "/seller/settings/member", label: "회원 정책" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="tabs" aria-label="쇼핑몰 설정">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={`tab${pathname === t.href ? " on" : ""}`} aria-current={pathname === t.href ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
