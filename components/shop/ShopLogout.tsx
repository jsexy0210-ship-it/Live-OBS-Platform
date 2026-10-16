"use client";

import { LogoutButton } from "../admin-ui/LogoutButton";

// SH-020 「로그아웃」 줄(내 정보 허브·왼쪽 메뉴): 공통 확인 창 「로그아웃할까요?」를 거쳐, 세션을 끊었을 때만 쇼핑몰 홈으로 간다(머리의 로그아웃과 같은 동작).
export default function ShopLogout({ slug, size = "md" }: { slug: string; size?: "sm" | "md" }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  async function logout() {
    const r = await fetch(`/api/shop/${encodeURIComponent(slug)}/auth/logout`, { method: "POST" }).catch(() => null);
    if (r?.ok) window.location.assign(base);
    return !!r?.ok;
  }
  return <LogoutButton tone="shop" className={`btn btn-out my-logout${size === "sm" ? " btn-sm" : ""}`} onLogout={logout} />;
}
