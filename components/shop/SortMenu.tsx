"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

// SH-002 정렬 드롭다운(보드 「신상품 ▾」): 누르면 목록이 펼쳐지고, 고르거나 바깥을 누르거나 Esc를 누르거나 주소가 바뀌면(쪽 이동 포함) 닫힌다.
export default function SortMenu({ current, items }: { current: string; items: { key: string; label: string; href: string }[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const path = usePathname();
  const qs = useSearchParams().toString();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [path, qs]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && el.open) {
        el.open = false;
        el.querySelector("summary")?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (el.open && !el.contains(e.target as Node)) el.open = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);
  const label = items.find((i) => i.key === current)?.label ?? "";
  return (
    <details ref={ref} className="shop-sortmenu">
      <summary>{label}</summary>
      <div>
        {items.map((i) => (
          <Link key={i.key} href={i.href} aria-current={i.key === current ? "page" : undefined}>
            {i.label}
          </Link>
        ))}
      </div>
    </details>
  );
}
