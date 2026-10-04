"use client";

import { useEffect, useId, useRef } from "react";

// 구매자 쇼핑몰 공통 모달(대표님 지시 2026-10-04): 제목 줄 오른쪽 위에 X(닫기), Esc·바깥 클릭으로도 닫힌다.
// 모든 구매자 화면 모달은 이 틀을 쓴다. 이벤트 팝업처럼 모양이 다른 것은 ModalClose만 가져다 쓴다.
export function ModalClose({ onClick, className = "", innerRef }: { onClick: () => void; className?: string; innerRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button ref={innerRef} type="button" className={`shop-modal-x ${className}`.trim()} aria-label="닫기" onClick={onClick}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

export default function ShopModal({ title, onClose, children, footer }: { title: string; onClose: () => void; children?: React.ReactNode; footer?: React.ReactNode }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);

  return (
    <div className="shop-modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shop-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="shop-modal-head">
          <h2 id={titleId}>{title}</h2>
          <ModalClose innerRef={closeRef} onClick={onClose} />
        </div>
        {children && <div className="shop-modal-body">{children}</div>}
        {footer && <div className="shop-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
