"use client";

import { useEffect, useId, useRef, useState } from "react";

// 공통 모달 기반(2026-10-05 시각 규격 「모달·드로어·바텀시트」). 관리자·구매자 화면이 함께 쓴다.
// - 오른쪽 위 같은 자리에 X(접근성 이름 「닫기」). X·Esc·바깥 클릭은 모두 「취소」와 같은 onClose 하나로 간다.
// - 열리면 initialFocus(없으면 본문 첫 입력·버튼, 그것도 없으면 X)로 포커스를 옮기고, Tab은 모달 안에서만 돈다.
//   닫히면 연 요소로 포커스를 돌려준다. 열려 있는 동안 배경 스크롤을 막는다.
// - busy: 저장·결제 처리 중에는 어떤 방법으로도 닫히지 않고 이유를 보인다(실패하면 busy를 풀어 닫기·재시도가 가능해야 한다).
// - dirty: 입력 중인 변경이 있으면 닫는 방법과 관계없이 같은 확인을 모달 안에서 묻는다(모달을 겹쳐 열지 않는다).
// - sheet: 휴대폰 폭(767px 이하)에서 아래에서 올라오는 바텀시트로 보인다. 짧은 입력에만 쓴다.
// - tone: 문구 말투. 관리자(admin)는 합니다체, 구매자(shop)는 해요체.
// 사용법:
//   {open && (
//     <Modal title="메모 수정" onClose={() => setOpen(false)} busy={saving} dirty={memo !== saved}
//       footer={(close) => <><button className="btn btn-out" type="button" onClick={close}>취소</button><button className="btn" …>저장</button></>}>
//       …
//     </Modal>
//   )}
// 스타일: styles/lop.css (.ui-modal-bg · .modal · .modal-x)

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

// 열린 모달 순서. Esc는 맨 위 모달만 받는다.
const stack: symbol[] = [];
let scrollLocks = 0;
let savedOverflow = "";

export function ModalClose({ onClick, disabled, innerRef }: { onClick: () => void; disabled?: boolean; innerRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button ref={innerRef} type="button" className="modal-x" aria-label="닫기" disabled={disabled} onClick={onClick}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

export function Modal({
  title,
  description,
  onClose,
  busy = false,
  busyText,
  dirty = false,
  tone = "admin",
  size = "md",
  sheet = false,
  initialFocus,
  footer,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  busyText?: string;
  dirty?: boolean;
  tone?: Tone;
  size?: "md" | "lg" | "xl";
  sheet?: boolean;
  initialFocus?: React.RefObject<HTMLElement | null>;
  // 함수로 주면 「취소」 버튼이 X·Esc와 같은 닫기 요청(close)을 쓸 수 있다(미저장 확인·처리 중 잠금이 같게 적용된다)
  footer?: React.ReactNode | ((close: () => void) => React.ReactNode);
  children?: React.ReactNode;
}) {
  const titleId = useId();
  const descId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const t = TEXT[tone];

  // 최신 값을 이벤트 처리기에서 읽는다(처리기는 한 번만 붙인다)
  const state = useRef({ busy, dirty, confirming, onClose });
  state.current = { busy, dirty, confirming, onClose };

  const requestClose = () => {
    const s = state.current;
    if (s.busy) return;
    if (s.dirty && !s.confirming) {
      setConfirming(true);
      return;
    }
    s.onClose();
  };
  const requestRef = useRef(requestClose);
  requestRef.current = requestClose;

  useEffect(() => {
    const id = Symbol("modal");
    stack.push(id);
    const before = document.activeElement as HTMLElement | null;
    const box = boxRef.current;
    const first = initialFocus?.current ?? box?.querySelector<HTMLElement>(`.modal-body ${FOCUSABLE}`) ?? closeRef.current;
    first?.focus();

    if (scrollLocks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id || !box) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (state.current.confirming) setConfirming(false);
        else requestRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement;
      if (!box.contains(active)) {
        e.preventDefault();
        head.focus();
      } else if (e.shiftKey && active === head) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.indexOf(id);
      if (at >= 0) stack.splice(at, 1);
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
      before?.focus?.();
    };
    // 열릴 때 한 번만 실행한다
  }, []);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  // dirty가 풀리면(저장 성공 등) 확인 상태도 푼다
  useEffect(() => {
    if (!dirty) setConfirming(false);
  }, [dirty]);

  return (
    <div
      className={`ui-modal-bg${sheet ? " is-sheet" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={boxRef}
        className={`modal${size === "lg" ? " modal-lg" : size === "xl" ? " modal-xl" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        aria-busy={busy || undefined}
      >
        <div className="modal-h">
          <h2 className="modal-t" id={titleId}>
            {title}
          </h2>
          {description && (
            <p className="modal-d" id={descId}>
              {description}
            </p>
          )}
        </div>
        <ModalClose innerRef={closeRef} onClick={requestClose} disabled={busy} />
        {children && <div className="modal-body">{children}</div>}
        {busy && (
          <p className="modal-busy" role="status">
            {busyText ?? t.busy}
          </p>
        )}
        {confirming ? (
          <div className="modal-confirm" role="alertdialog" aria-label={t.dirty}>
            <p>{t.dirty}</p>
            <div className="modal-f">
              <button ref={keepRef} type="button" className="btn btn-out" onClick={() => setConfirming(false)}>
                {t.keep}
              </button>
              <button type="button" className="btn btn-neg" onClick={() => state.current.onClose()}>
                {t.discard}
              </button>
            </div>
          </div>
        ) : (
          footer && <div className="modal-f">{typeof footer === "function" ? footer(requestClose) : footer}</div>
        )}
      </div>
    </div>
  );
}
