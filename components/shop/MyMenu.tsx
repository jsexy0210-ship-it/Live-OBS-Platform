"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import "./MyMenu.css";

// 내 정보 화면 왼쪽 메뉴(시안 04 SH). 지금 있는 화면만 넣고, 주문 내역·배송지·적립금 같은 화면이 생기면 더한다.
export default function MyMenu({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = usePathname() ?? "";
  const groups = [
    { title: "주문", links: [{ href: `${base}/orders`, label: "주문 내역" }] },
    { title: "혜택", links: [{ href: `${base}/coupons`, label: "내 쿠폰함" }] },
    {
      title: "활동",
      links: [
        { href: `${base}/me/inquiries`, label: "내 문의" },
        { href: `${base}/reviews`, label: "내 리뷰" },
        { href: `${base}/wishlist`, label: "찜" },
      ],
    },
    { title: "설정", links: [{ href: `${base}/me/notifications`, label: "알림 설정" }] },
  ];
  return (
    <nav className="my-menu" aria-label="내 정보 메뉴">
      <p className="my-menu-h">내 정보</p>
      {groups.map((g) => (
        <div key={g.title}>
          <p className="my-menu-g">{g.title}</p>
          {g.links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={path === l.href ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
