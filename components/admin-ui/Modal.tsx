"use client";

import { useEffect, useRef } from "react";

// 관리자 화면 공통 모달(대표님 지시 2026-10-04 「전체 모달 우측 상단에 X 버튼」, 파트너스·마스터 관리자 모두 사용).
// 사용: <Modal labelId="refund-title" className="modal-lg" busy={busy} onClose={close}>…제목(id=labelId)·본문·하단 버튼…</Modal>
//  - 오른쪽 위에 X 버튼(aria-label 「닫기」). X·Esc·바깥 클릭은 모두 onClose(=취소)를 부른다
//  - busy(처리 중)이면 X·Esc·바깥 클릭을 막는다. 모달이 여러 겹이면 맨 위 모달만 Esc에 닫힌다
//  - 열리면 첫 입력·버튼으로 포커스를 옮기고 Tab이 모달 밖으로 나가지 않으며, 닫히면 열기 전 위치로 돌려 둔다
//  - 모달 안 내용·제목 모양은 호출하는 쪽이 그대로 만든다(className에는 modal-lg·modal-xl 등 크기·화면별 클래스만)
const stack: symbol[] = [];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({ labelId, className, busy = false, onClose, children }: { labelId: string; className?: string; busy?: boolean; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ busy, onClose });
  live.current = { busy, onClose };
  const downOnDim = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const id = Symbol("modal");
    stack.push(id);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!el.contains(document.activeElement)) (focusables().find((n) => !n.classList.contains("modal-x")) ?? focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        if (!live.current.busy) live.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return e.preventDefault();
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(id), 1);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className="dim dim-fixed"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      onMouseDown={(e) => {
        downOnDim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnDim.current && e.target === e.currentTarget && !live.current.busy) live.current.onClose();
        downOnDim.current = false;
      }}
    >
      <div className={`modal modal-x-host${className ? ` ${className}` : ""}`} ref={box}>
        {children}
        <button className="modal-x" type="button" aria-label="닫기" disabled={busy} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
