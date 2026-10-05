"use client";

import { useEffect, useState } from "react";
import { Modal } from "../../admin-ui";
import { TIMER_MAX_SECONDS, clock, type QueueItem } from "./queue";

// SA-001 확인 창: 방송 종료 · 주문 취소(사유 필수) · 타이머 설정. X·Esc·바깥 클릭으로 닫는다(처리 중에는 닫지 않는다, 공통 Modal).
// blocked: 대시보드 내용이 최신이 아님(다시 불러오기 전까지 확인 버튼을 끈다, 닫기는 된다)

function Frame({ id, title, sub, busy, onClose, children }: { id: string; title: string; sub?: string; busy: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal labelId={id} busy={busy} onClose={onClose}>
      <div className="modal-h">
        <h2 className="t-h2" id={id}>
          {title}
        </h2>
        {sub && <span className="t-l2 c-alt">{sub}</span>}
      </div>
      {children}
    </Modal>
  );
}

const who = (item: QueueItem) => `${item.nicknameSnapshot} · ${item.productLabel} ×${item.quantity}`;

export function EndBroadcastModal({ waiting, busy, blocked, onClose, onConfirm }: { waiting: number; busy: boolean; blocked: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Frame busy={busy} onClose={onClose} id="bc-end-title" title="방송을 종료하시겠습니까?" sub={waiting > 0 ? `남은 대기 ${waiting}건은 다음 방송으로 넘어갑니다` : undefined}>
      <div className="modal-f">
        <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
          닫기
        </button>
        <button className="btn btn-neg" type="button" disabled={busy || blocked} onClick={onConfirm}>
          방송 종료
        </button>
      </div>
    </Frame>
  );
}

export function CancelItemModal({ item, busy, blocked, onClose, onConfirm }: { item: QueueItem; busy: boolean; blocked: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length > 0;
  return (
    <Frame busy={busy} onClose={onClose} id="bc-cancel-title" title="이 주문을 취소하시겠습니까?" sub={who(item)}>
      <form
        className="col"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy && !blocked) onConfirm(reason.trim());
        }}
      >
        <div className="fld">
          <label htmlFor="bc-cancel-reason" className="req">
            취소 사유
          </label>
          <input id="bc-cancel-reason" className="inp" maxLength={200} value={reason} disabled={busy} autoFocus onChange={(e) => setReason(e.target.value)} />
          <span className="help">주문대기에서만 빠집니다. 결제 취소·환불은 주문 화면에서 합니다</span>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            닫기
          </button>
          <button className="btn btn-neg" type="submit" disabled={busy || blocked || !ok}>
            주문대기 취소
          </button>
        </div>
      </form>
    </Frame>
  );
}

const PRESETS = [60, 180, 300, 600];

export function TimerModal({ item, busy, blocked, onClose, onConfirm }: { item: QueueItem; busy: boolean; blocked: boolean; onClose: () => void; onConfirm: (seconds: number) => void }) {
  const [min, setMin] = useState(String(Math.floor(item.timerSeconds / 60)));
  const [sec, setSec] = useState(String(item.timerSeconds % 60));
  const m = /^\d{1,2}$/.test(min) ? Number(min) : NaN;
  const s = /^\d{1,2}$/.test(sec) ? Number(sec) : NaN;
  const total = m * 60 + s;
  const ok = Number.isInteger(total) && s < 60 && total >= 0 && total <= TIMER_MAX_SECONDS;
  const set = (v: number) => {
    setMin(String(Math.floor(v / 60)));
    setSec(String(v % 60));
  };
  return (
    <Frame busy={busy} onClose={onClose} id="bc-timer-title" title="타이머 설정" sub={who(item)}>
      <form
        className="col"
        style={{ gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy && !blocked) onConfirm(total);
        }}
      >
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button key={p} className="chip" type="button" disabled={busy} onClick={() => set(p)}>
              {p / 60}분
            </button>
          ))}
          <button className="chip" type="button" disabled={busy} onClick={() => set(0)}>
            끄기
          </button>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <label className="sr" htmlFor="bc-timer-min">
            분
          </label>
          <input id="bc-timer-min" className="inp num bc-timer-inp" inputMode="numeric" maxLength={2} value={min} disabled={busy} onChange={(e) => setMin(e.target.value.trim())} />
          <span>분</span>
          <label className="sr" htmlFor="bc-timer-sec">
            초
          </label>
          <input id="bc-timer-sec" className="inp num bc-timer-inp" inputMode="numeric" maxLength={2} value={sec} disabled={busy} onChange={(e) => setSec(e.target.value.trim())} />
          <span>초</span>
        </div>
        <span className={ok ? "help" : "err"}>{ok ? (total === 0 ? "타이머를 끕니다" : `${clock(total)} 동안 카운트다운합니다`) : "0초부터 60분까지 정할 수 있습니다"}</span>
        <div className="modal-f">
          <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
            닫기
          </button>
          <button className="btn" type="submit" disabled={busy || blocked || !ok}>
            저장
          </button>
        </div>
      </form>
    </Frame>
  );
}
