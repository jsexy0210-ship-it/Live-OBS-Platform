"use client";

import { useCallback, useEffect, useRef } from "react";
import { askLeaveDialog, leaveDialogAvailable, type LeaveDialog } from "./leaveDialog";

const DEFAULT_MESSAGE = "저장하지 않은 변경이 있습니다. 이 화면을 나가시겠습니까?";

/**
 * 저장하지 않은 변경 보호. 새로고침·탭 닫기(beforeunload), 앱 안 링크 클릭, 브라우저 Back을 한 곳에서 같은 확인으로 막는다.
 * 화면 ← 버튼(useSmartBack)·router.push 호출은 아래 `confirmLeave()`로 직접 묻는다.
 */
export function useUnsavedGuard(dirty: boolean, message: string = DEFAULT_MESSAGE, options?: { dialog?: LeaveDialog }) {
  const release = useRef<() => Promise<void>>(async () => {});
  // 화면이 공통 확인 창(.cfm)을 고르면 링크·브라우저 Back의 확인을 그 창으로 묻는다(고르지 않으면 브라우저 확인 창)
  const dialog = options?.dialog;
  const dialogTitle = dialog?.title;
  const dialogBody = dialog?.body;
  const dialogStay = dialog?.stayLabel;
  const dialogLeave = dialog?.leaveLabel;
  useEffect(() => {
    if (!dirty) return;
    const useDialog = dialogTitle !== undefined && leaveDialogAvailable();
    const ask = () => askLeaveDialog({ title: dialogTitle ?? message, body: dialogBody, stayLabel: dialogStay, leaveLabel: dialogLeave });
    let asking = false;
    let bypass = false;

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
      if (useDialog) {
        // 창은 기다려야 해서 이동을 먼저 막고, 「저장 안 함」이면 같은 링크를 다시 눌러 이동한다
        if (bypass) {
          bypass = false;
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (asking) return;
        asking = true;
        void ask().then((leave) => {
          asking = false;
          if (!leave) return;
          bypass = true;
          a.click();
        });
        return;
      }
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
      if (useDialog) {
        if (asking) return;
        asking = true;
        void ask().then((leave) => {
          asking = false;
          if (released) return;
          if (leave) {
            released = true;
            window.removeEventListener("popstate", onPop);
            history.back();
          } else {
            history.pushState({ unsavedGuard: true }, "", location.href);
          }
        });
        return;
      }
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
  }, [dirty, message, dialogTitle, dialogBody, dialogStay, dialogLeave]);
  return useCallback(() => release.current(), []);
}

/** 화면 ←·취소 버튼 등 코드로 나가는 경로에서 쓴다. 변경이 없으면 바로 true */
export function confirmLeave(dirty: boolean, message: string = DEFAULT_MESSAGE): boolean {
  return !dirty || window.confirm(message);
}

/** confirmLeave의 공통 확인 창(.cfm) 판. 화면 ←·취소 버튼처럼 코드로 나가는 길에서 쓴다. 변경이 없으면 바로 true */
export async function confirmLeaveDialog(dirty: boolean, dialog: LeaveDialog): Promise<boolean> {
  return !dirty || askLeaveDialog(dialog);
}
