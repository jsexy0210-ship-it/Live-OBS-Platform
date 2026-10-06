"use client";

import { useCallback, useEffect, useRef } from "react";

const DEFAULT_MESSAGE = "저장하지 않은 변경이 있습니다. 이 화면을 나가시겠습니까?";

/**
 * 저장하지 않은 변경 보호. 새로고침·탭 닫기(beforeunload), 앱 안 링크 클릭, 브라우저 Back을 한 곳에서 같은 확인으로 막는다.
 * 화면 ← 버튼(useSmartBack)·router.push 호출은 아래 `confirmLeave()`로 직접 묻는다.
 */
export function useUnsavedGuard(dirty: boolean, message: string = DEFAULT_MESSAGE) {
  const release = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // 링크(GNB·LNB·경로 줄 등): 캡처 단계에서 가로채 확인 후 취소하면 이동을 막는다
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // 브라우저 Back: 같은 주소의 기록 한 칸을 얹어 두고, popstate에서 확인 후 취소하면 다시 얹는다
    const guardedUrl = location.href;
    history.pushState({ ...history.state, unsavedGuard: true }, "", guardedUrl);
    let released = false;
    const onPop = () => {
      if (released) return;
      if (window.confirm(message)) {
        released = true;
        window.removeEventListener("popstate", onPop);
        history.back(); // 얹어 둔 칸을 지나 실제 이전 화면으로
      } else {
        history.pushState({ unsavedGuard: true }, "", location.href);
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    // 저장 성공은 확인 없이 보호용 기록만 소비한 뒤 URL을 바꾼다.
    release.current = async () => {
      released = true;
      window.removeEventListener("popstate", onPop);
      if (!history.state?.unsavedGuard || location.href !== guardedUrl) return;
      await new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
        history.back();
      });
    };
    return () => {
      release.current = async () => {};
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, [dirty, message]);
  return useCallback(() => release.current(), []);
}

/** 화면 ←·취소 버튼 등 코드로 나가는 경로에서 쓴다. 변경이 없으면 바로 true */
export function confirmLeave(dirty: boolean, message: string = DEFAULT_MESSAGE): boolean {
  return !dirty || window.confirm(message);
}
