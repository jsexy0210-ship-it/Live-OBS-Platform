"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/** 한 줄 유지 · 넘치면 글자 크기 자동 축소 */
export function FitText({ children, className, min = 0.4 }: { children: ReactNode; className?: string; min?: number }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const fit = () => {
      el.style.fontSize = "";
      const available = el.clientWidth;
      const needed = el.scrollWidth;
      if (available > 0 && needed > available) {
        const base = parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = `${Math.max(base * min, (base * available) / needed - 0.5)}px`;
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    if (el.parentElement) observer.observe(el.parentElement);
    document.fonts?.ready.then(fit).catch(() => undefined);
    return () => observer.disconnect();
  }, [children, min]);

  return (
    <span ref={ref} className={className ? `fitText ${className}` : "fitText"}>
      {children}
    </span>
  );
}
