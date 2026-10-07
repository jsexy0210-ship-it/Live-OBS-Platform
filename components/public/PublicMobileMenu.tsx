"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import styles from "./PublicMobileMenu.module.css";

type NavLink = { href: string; label: string };

export function PublicMobileMenu({ links, active }: { links: NavLink[]; active?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        triggerRef.current?.focus();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <div className={styles.root}>
      <button
        ref={triggerRef}
        className="icon-btn"
        type="button"
        aria-label={open ? "메뉴 닫기" : "메뉴"}
        aria-expanded={open}
        aria-controls="public-mobile-nav"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        )}
      </button>
      {open && (
        <nav id="public-mobile-nav" className={styles.menu} aria-label="모바일 주요 메뉴">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.href === active ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
