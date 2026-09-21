"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { CALCULATORS } from "@/lib/calculators";

const MENU = [{ href: "/", label: "홈" }, ...CALCULATORS.map((item) => ({ href: item.href, label: item.title }))];
const INFO = [
  { href: "/about/", label: "서비스 소개" },
  { href: "/privacy/", label: "개인정보처리방침" }
];

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname?.startsWith(href));

  return (
    <>
      <nav className="desktopNav" aria-label="계산기">
        {CALCULATORS.map((item) => (
          <Link href={item.href} key={item.href} aria-current={isActive(item.href) ? "page" : undefined}>
            {item.nav}
          </Link>
        ))}
      </nav>

      <button
        type="button"
        className="menuButton"
        aria-label={open ? "메뉴 닫기" : "메뉴 열기"}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={open ? "menuIcon open" : "menuIcon"} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      {open ? (
        <div className="mobileMenuBackdrop" onClick={() => setOpen(false)}>
          <nav id="mobile-menu" className="mobileMenu" aria-label="전체 메뉴" onClick={(event) => event.stopPropagation()}>
            <ul>
              {MENU.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} aria-current={isActive(item.href) ? "page" : undefined} onClick={() => setOpen(false)}>
                    <span>{item.label}</span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="mobileMenuInfo">
              {INFO.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} onClick={() => setOpen(false)}>{item.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      ) : null}
    </>
  );
}
