"use client";

import { useEffect, useRef, useState } from "react";

// 공통 모달 기반(대표님 지시 2026-10-04 「모달 오른쪽 위 X」, 2026-10-05 시각 규격 「모달·드로어·바텀시트」). 관리자·구매자 화면이 함께 쓴다.
// 호출 모양은 레이아웃 전담 (2)의 feat/admin-modal(파트너스 모달 전환분)과 같다. 그 전환은 이 부품 위에 그대로 올린다.
// 사용:
//   <Modal labelId="memo-title" busy={saving} dirty={memo !== saved} onClose={close}>
//     <div className="modal-h"><h2 className="modal-t" id="memo-title">메모 수정</h2></div>
//     …본문…
//     <div className="modal-f"><button className="btn btn-out" type="button" onClick={close}>취소</button>…</div>
//   </Modal>
//  - 오른쪽 위 같은 자리에 X(접근성 이름 「닫기」, 조작 영역 44px). X·Esc·바깥 클릭은 모두 「취소」와 같은 닫기 요청이다
//  - 열리면 X가 아닌 첫 입력·버튼으로 포커스를 옮기고 Tab은 모달 안에서만 돈다. 닫히면 연 요소로 돌려준다. 열린 동안 배경 스크롤을 막는다
//  - busy: 저장·결제 처리 중에는 X·Esc·바깥 클릭으로 닫히지 않고 이유를 보인다(실패하면 busy를 풀어 닫기·재시도가 다시 되어야 한다)
//  - dirty: 입력 중인 변경이 있으면 X·Esc·바깥 클릭 모두 같은 미저장 확인을 모달 안에서 묻는다(모달을 겹쳐 열지 않는다).
//    「취소」 버튼도 같은 확인을 거치려면 requestClose를 쓰는 render 함수로 children을 준다: {(requestClose) => …}
//  - 여러 겹이면 맨 위 모달만 Esc를 받는다
//  - sheet: 휴대폰 폭(767px 이하)에서 아래에서 올라오는 바텀시트. 짧은 입력에만 쓴다
//  - tone: 문구 말투. 관리자(admin)는 합니다체, 구매자(shop)는 해요체
// 스타일: styles/lop.css (.ui-modal-bg · .modal · .modal-x · .modal-busy · .modal-confirm)

type Tone = "admin" | "shop";

const TEXT: Record<Tone, { busy: string; dirty: string; keep: string; discard: string }> = {
  admin: {
    busy: "처리 중입니다. 끝날 때까지 닫을 수 없습니다.",
    dirty: "저장하지 않은 변경이 있습니다. 닫으면 입력한 내용이 사라집니다. 닫으시겠습니까?",
    keep: "계속 작성",
    discard: "닫기",
  },
  shop: {
    busy: "처리하고 있어요. 끝날 때까지 닫을 수 없어요",
    dirty: "저장하지 않은 내용이 있어요. 닫으면 입력한 내용이 사라져요",
    keep: "계속 쓰기",
    discard: "닫기",
  },
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const stack: symbol[] = [];
let scrollLocks = 0;
let savedOverflow = "";

export function Modal({
  labelId,
  className,
  busy = false,
  busyText,
  dirty = false,
  tone = "admin",
  sheet = false,
  onClose,
  children,
}: {
  labelId: string;
  className?: string;
  busy?: boolean;
  busyText?: string;
  dirty?: boolean;
  tone?: Tone;
  sheet?: boolean;
  onClose: () => void;
  children: React.ReactNode | ((requestClose: () => void) => React.ReactNode);
}) {
  const box = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const downOnDim = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const live = useRef({ busy, dirty, confirming, onClose });
  live.current = { busy, dirty, confirming, onClose };
  const t = TEXT[tone];

  const requestClose = () => {
    const s = live.current;
    if (s.busy) return;
    if (s.dirty && !s.confirming) return setConfirming(true);
    s.onClose();
  };
  const requestRef = useRef(requestClose);
  requestRef.current = requestClose;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const id = Symbol("modal");
    stack.push(id);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!el.contains(document.activeElement)) (focusables().find((n) => !n.classList.contains("modal-x")) ?? focusables()[0] ?? el).focus();

    if (scrollLocks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (live.current.confirming) setConfirming(false);
        else requestRef.current();
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
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // 확인이 뜨면 「계속 작성」으로, 거두면 모달 첫 입력으로 포커스를 옮긴다(사라진 버튼에 포커스가 남지 않게)
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) box.current?.querySelector<HTMLElement>(`${FOCUSABLE.split(",").map((f) => `${f}:not(.modal-x)`).join(",")}`)?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  // 저장 성공 등으로 dirty가 풀리면 확인도 거둔다
  useEffect(() => {
    if (!dirty) setConfirming(false);
  }, [dirty]);

  return (
    <div
      className={`ui-modal-bg${sheet ? " is-sheet" : ""}`}
      onMouseDown={(e) => {
        downOnDim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // 모달 안에서 누르고 바깥에서 뗀 드래그는 닫지 않는다
        if (downOnDim.current && e.target === e.currentTarget) requestClose();
        downOnDim.current = false;
      }}
    >
      <div className={`modal${className ? ` ${className}` : ""}`} ref={box} role="dialog" aria-modal="true" aria-labelledby={labelId} aria-busy={busy || undefined}>
        {typeof children === "function" ? children(requestClose) : children}
        {busy && (
          <p className="modal-busy" role="status">
            {busyText ?? t.busy}
          </p>
        )}
        {confirming && (
          <div className="modal-confirm" role="alert">
            <p>{t.dirty}</p>
            <div className="modal-f">
              <button ref={keepRef} type="button" className="btn btn-out" onClick={() => setConfirming(false)}>
                {t.keep}
              </button>
              <button type="button" className="btn btn-neg" onClick={() => live.current.onClose()}>
                {t.discard}
              </button>
            </div>
          </div>
        )}
        <button className="modal-x" type="button" aria-label="닫기" disabled={busy} onClick={requestClose}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
