"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  return (
    <nav className="tabs" aria-label="쇼핑몰 설정">
      {TABS.filter((t) => !t.perm || can(t.perm)).map((t) => (
        <Link key={t.href} href={t.href} className={`tab${pathname === t.href ? " on" : ""}`} aria-current={pathname === t.href ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
