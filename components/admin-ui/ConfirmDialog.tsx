"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { confirmButtonWidth, retypeMatches } from "./confirmUtil";

// 공통 확인 창(DS-CONFIRM 정본, 대표님 지시 2026-10-06): 서버에 쓰는 모든 행동(저장·삭제·변경·상태 변경·일괄 처리) 앞에 띄운다. 읽기·이동·필터는 띄우지 않는다.
// 구성: 제목 한 줄(관리자 「~하시겠습니까?」·구매자 「~할까요?」) → 본문 1~2줄(바뀌는 대상·결과·건너뛰는 것) → [취소][실행 이름]. 실행 이름은 「확인」이 아니라 행동 그대로(저장·삭제·5건 변경·환불).
// 위험 행동은 실행 버튼만 위험 색. 매우 위험(환불·적립금·결제·계정)은 retype으로 금액(또는 이름)을 다시 입력해야 실행이 켜진다.
// X·Esc·바깥 클릭 = 취소. 열리면 취소로 포커스, 닫히면 연 요소로 복귀, 배경 스크롤 막음(Modal 기반). 처리 중에는 닫기를 막고 실행 문구만 「처리 중」. 겹쳐 열지 않는다.
//
// 사용(셸이 ConfirmProvider를 이미 감싸 둔다):
//   const { confirm, readOnly } = useConfirm();
//   // 1) 결과만 받기
//   if (!(await confirm({ title: "변경 사항을 저장하시겠습니까?", body: "배송비 정책 3개 항목이 바뀝니다 · 저장 즉시 쇼핑몰 주문서에 적용됩니다.", confirmLabel: "저장" }))) return;
//   await save();
//   // 2) 처리까지 맡기기(권장): run이 끝날 때까지 「처리 중」, 문자열을 돌려주면 그 오류를 창 안에 보이고 열어 둔 채 다시 시도하게 한다
//   const ok = await confirm({ title: "「스타라이트 부스터 박스」를 숨김으로 바꾸시겠습니까?", body: "…", confirmLabel: "숨김으로 변경", run: async () => (await api(...)).ok ? undefined : "숨기지 못했습니다" });
//   // 3) 매우 위험: retype / 위험: danger
//   confirm({ title: "24,000원을 환불하시겠습니까?", body: "…환불 금액을 다시 입력해 주십시오", confirmLabel: "환불", danger: true, retype: { expected: "24000", label: "환불 금액" }, run })
// 대리 조회(me.readOnly) 중에는 confirm이 열리지 않고 「대리 조회 중에는 바꿀 수 없습니다」 안내만 보이며 false를 돌려준다. 화면은 readOnly로 실행 버튼을 비활성할 수 있다.
// 대리 조회에서도 되는 행동(대리 조회 끝내기 등)은 allowReadOnly: true.
// 스타일: styles/lop.css (.ui-modal-bg · .modal · .modal-h · .modal-f · .modal-x)

export type ConfirmOptions = {
  title: string;
  body?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  retype?: { expected: string; label?: string };
  tone?: "admin" | "shop";
  run?: () => Promise<void | string>;
  allowReadOnly?: boolean;
};

const TEXT = {
  admin: { cancel: "취소", running: "처리 중", failed: "처리하지 못했습니다. 잠시 후 다시 시도해 주십시오", retypeHint: "다시 입력해 주십시오", roTitle: "대리 조회 중에는 바꿀 수 없습니다", roBody: "읽기 전용으로 보는 중입니다. 변경은 파트너스 본인이 합니다.", close: "닫기" },
  shop: { cancel: "취소", running: "처리 중", failed: "처리하지 못했어요. 잠시 뒤 다시 시도해 주세요", retypeHint: "다시 입력해 주세요", roTitle: "지금은 바꿀 수 없어요", roBody: "읽기 전용으로 보는 중이에요.", close: "닫기" },
} as const;

export function ConfirmDialog({ opts, onResult }: { opts: ConfirmOptions; onResult: (ok: boolean) => void }) {
  const tone = opts.tone ?? "admin";
  const t = TEXT[tone];
  const labelId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const cancelLabel = opts.cancelLabel ?? t.cancel;
  const width = confirmButtonWidth(cancelLabel, opts.confirmLabel);
  const ready = !opts.retype || retypeMatches(typed, opts.retype.expected);

  const go = async () => {
    if (busy || !ready) return;
    if (!opts.run) return onResult(true);
    setBusy(true);
    setError(null);
    try {
      const msg = await opts.run();
      if (typeof msg === "string" && msg) {
        if (alive.current) {
          setError(msg);
          setBusy(false);
        }
        return;
      }
      onResult(true);
    } catch {
      if (alive.current) {
        setError(t.failed);
        setBusy(false);
      }
    }
  };

  return (
    <Modal labelId={labelId} className="confirm-dialog" busy={busy} busyText="" tone={tone} sheet={tone === "shop"} onClose={() => onResult(false)}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id={labelId}>
              {opts.title}
            </h2>
          </div>
          {opts.body && <div className="confirm-body">{opts.body}</div>}
          {opts.retype && (
            <label className="confirm-retype">
              <span>{opts.retype.label ?? t.retypeHint}</span>
              <input className="inp" value={typed} inputMode="text" autoComplete="off" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
            </label>
          )}
          {error && (
            <p className="confirm-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-f">
            <button type="button" className={`btn btn-out ${width}`} disabled={busy} onClick={requestClose}>
              {cancelLabel}
            </button>
            <button type="button" className={`btn ${opts.danger ? "btn-neg" : ""} ${width}`.trim()} disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void go()}>
              {busy ? t.running : opts.confirmLabel}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

type Pending = { opts: ConfirmOptions; resolve: (ok: boolean) => void };
type Api = { confirm: (opts: ConfirmOptions) => Promise<boolean>; readOnly: boolean };
const Ctx = createContext<Api | null>(null);

export function ConfirmProvider({ readOnly = false, children }: { readOnly?: boolean; children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<"admin" | "shop" | null>(null);
  const openRef = useRef(false);
  openRef.current = !!pending || !!notice;

  const confirm = useCallback(
    (opts: ConfirmOptions) => {
      // 창을 겹쳐 열지 않는다
      if (openRef.current) return Promise.resolve(false);
      if (readOnly && !opts.allowReadOnly) {
        setNotice(opts.tone ?? "admin");
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => setPending({ opts, resolve }));
    },
    [readOnly],
  );
  const api = useMemo(() => ({ confirm, readOnly }), [confirm, readOnly]);
  const finish = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {pending && <ConfirmDialog opts={pending.opts} onResult={finish} />}
      {notice && <ReadOnlyNotice tone={notice} onClose={() => setNotice(null)} />}
    </Ctx.Provider>
  );
}

// 대리 조회 중 쓰기 행동: 확인 창 대신 안내(닫기 하나)
function ReadOnlyNotice({ tone, onClose }: { tone: "admin" | "shop"; onClose: () => void }) {
  const t = TEXT[tone];
  const labelId = useId();
  return (
    <Modal labelId={labelId} className="confirm-dialog" tone={tone} sheet={tone === "shop"} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id={labelId}>
              {t.roTitle}
            </h2>
          </div>
          <div className="confirm-body">{t.roBody}</div>
          <div className="modal-f">
            <button type="button" className="btn btn-out btn-w-md" onClick={requestClose}>
              {t.close}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function useConfirm(): Api {
  const v = useContext(Ctx);
  if (!v) throw new Error("ConfirmProvider 안에서만 쓸 수 있습니다(셸이 감싸 줍니다)");
  return v;
}
