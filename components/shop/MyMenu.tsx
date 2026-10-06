"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import "./MyMenu.css";

// 내 정보 왼쪽 메뉴(SH-020-IA·SH-027-IA). 지금 있는 화면만 넣고, 적립금·배송지 같은 화면이 생기면 해당 그룹에 더한다.
// PC는 왼쪽에 4그룹(쇼핑·혜택·활동·내 정보)을 계속 보인다. 휴대폰은 메뉴를 펼치지 않고 하위 화면 위에 「‹ 제목 · 그룹」 한 줄만 둔다(메뉴는 「내 정보」 탭에서 고른다).
export default function MyMenu({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = usePathname() ?? "";
  const groups = [
    {
      title: "쇼핑",
      links: [
        { href: `${base}/orders`, label: "주문 내역 · 취소 · 환불", short: "주문 내역" },
        { href: `${base}/me/addresses`, label: "배송지 관리" },
      ],
    },
    { title: "혜택", links: [{ href: `${base}/coupons`, label: "내 쿠폰함" }] },
    {
      title: "활동",
      links: [
        { href: `${base}/reviews`, label: "내 리뷰" },
        { href: `${base}/wishlist`, label: "찜" },
      ],
    },
    { title: "내 정보", links: [{ href: `${base}/me/notifications`, label: "알림 설정" }] },
  ];
  const now = groups.flatMap((g) => g.links.map((l) => ({ ...l, group: g.title }))).find((l) => path === l.href || path.startsWith(`${l.href}/`));
  return (
    <>
      {now && (
        <div className="my-back">
          <Link href={`${base}/me`} aria-label="내 정보로 돌아가기">
            ‹
          </Link>
          <b>{"short" in now ? now.short : now.label}</b>
          <span>{now.group}</span>
        </div>
      )}
      <nav className="my-menu" aria-label="내 정보 메뉴">
        <p className="my-menu-h">
          <Link href={`${base}/me`}>내 정보</Link>
        </p>
        {groups.map((g) => (
          <div key={g.title}>
            <p className="my-menu-g">{g.title}</p>
            {g.links.map((l) => (
              <Link key={l.href} href={l.href} aria-current={path === l.href || path.startsWith(`${l.href}/`) ? "page" : undefined}>
                {l.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </>
  );
}
