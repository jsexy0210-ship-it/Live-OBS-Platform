"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { myGroups } from "./myGroups";
import "./MyMenu.css";

// 내 정보 화면 왼쪽 메뉴(시안 04 SH). 지금 있는 화면만 넣고, 주문 내역·배송지·적립금 같은 화면이 생기면 더한다.
export default function MyMenu({ slug }: { slug: string }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const path = usePathname() ?? "";
  const groups = myGroups(base);
  return (
    <nav className="my-menu" aria-label="내 정보 메뉴">
      <Link className="my-menu-h" href={`${base}/me`}>
        내 정보
      </Link>
      {groups.map((g) => (
        <div key={g.title} className="my-menu-grp">
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
