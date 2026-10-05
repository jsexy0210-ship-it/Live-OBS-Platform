"use client";

import { useEffect } from "react";

/**
 * 목록 스크롤 복원. 상세로 나갈 때 위치를 sessionStorage에 저장하고, 돌아와 목록이 그려진 뒤(ready=true) 한 번 복원한다.
 * key는 목록마다 고유하게(예: "seller-products"). 조회가 끝나기 전에는 ready=false로 둔다.
 */
export function useScrollRestore(key: string, ready: boolean) {
  const storageKey = `scroll:${key}`;
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(storageKey, String(window.scrollY));
      } catch {}
    };
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [storageKey]);

  useEffect(() => {
    if (!ready) return;
    try {
      const y = Number(sessionStorage.getItem(storageKey));
      sessionStorage.removeItem(storageKey);
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    } catch {}
  }, [ready, storageKey]);
}
