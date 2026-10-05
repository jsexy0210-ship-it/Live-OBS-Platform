"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { canGoBackTo, onNavigate, previousOf, type NavStack } from "./navStack";

// 앱 안 이동 기록. 루트 레이아웃에 한 번 둔다(<NavigationTracker />). 두지 않으면 화면 ←는 항상 부모로 replace한다.
let stack: NavStack = [];
let nextKind: "push" | "replace" | null = null;
let popped = false;
let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("popstate", () => {
    popped = true;
  });
}

/** 다음 경로 변경이 history를 쌓지 않는 replace임을 알린다(useUrlState가 호출) */
export function markNextReplace() {
  nextKind = "replace";
}

export function canGoBackWithin(fallback: string): boolean {
  return canGoBackTo(previousOf(stack), fallback);
}

export function NavigationTracker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = pathname + (search ? `?${search}` : "");
  listen();
  useEffect(() => {
    const kind = popped ? "pop" : (nextKind ?? "push");
    popped = false;
    nextKind = null;
    stack = onNavigate(stack, here, kind);
  }, [here]);
  return null;
}
