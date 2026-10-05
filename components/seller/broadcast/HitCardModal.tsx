"use client";

import { useState } from "react";
import { Modal } from "../../admin-ui";
import { api, failMessage } from "../api";

// HIT 카드 등록 창(SA-001 방송 대시보드 · SA-053 HIT 카드 이력 공용). 공통 Modal 위에 만든다.
// API: POST /api/seller/hit-cards { cardName(60자), note?(200자), queueItemId | nickname(30자) } → 201 { card }. 등록하면 오버레이에 바로 나온다.
// targets: 고를 수 있는 주문(첫 번째가 기본). 비어 있거나 「직접 입력」을 고르면 구매자 닉네임을 직접 적는다.
// 시안의 등급·카드 이미지·오버레이 노출 시간은 서버가 받지 않아 두지 않았다.

export type HitTarget = { queueItemId: string; label: string };

const MANUAL = "";

export function HitCardModal({ targets, onClose, onDone }: { targets: HitTarget[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState(targets[0]?.queueItemId ?? MANUAL);
  const [cardName, setCardName] = useState("");
  const [nickname, setNickname] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manual = target === MANUAL;
  const ok = cardName.trim() !== "" && (!manual || nickname.trim() !== "");
  const dirty = cardName !== "" || nickname !== "" || note !== "";

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    const r = await api<{ card: { id: string } }>("/api/seller/hit-cards", {
      method: "POST",
      body: { cardName: cardName.trim(), ...(note.trim() ? { note: note.trim() } : {}), ...(manual ? { nickname: nickname.trim() } : { queueItemId: target }) },
    });
    setBusy(false);
    if (!r.ok) return setError(failMessage(r, "admin"));
    onDone();
  };

  return (
    <Modal labelId="hit-add-title" busy={busy} dirty={dirty} onClose={onClose}>
      {(requestClose) => (
        <form
          className="col"
          style={{ gap: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="modal-h">
            <h2 className="modal-t" id="hit-add-title">
              HIT 카드 기록하기
            </h2>
            <span className="t-l2 c-alt">기록하면 방송 화면에 바로 나옵니다</span>
          </div>
          <div className="fld">
            <label htmlFor="hit-target" className="req">
              카드를 받은 주문
            </label>
            <select id="hit-target" className="inp" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((t) => (
                <option key={t.queueItemId} value={t.queueItemId}>
                  {t.label}
                </option>
              ))}
              <option value={MANUAL}>닉네임 직접 쓰기</option>
            </select>
          </div>
          {manual && (
            <div className="fld">
              <label htmlFor="hit-nickname" className="req">
                구매자 닉네임
              </label>
              <input id="hit-nickname" className="inp" maxLength={30} value={nickname} disabled={busy} onChange={(e) => setNickname(e.target.value)} />
            </div>
          )}
          <div className="fld">
            <label htmlFor="hit-card-name" className="req">
              카드명
            </label>
            <input id="hit-card-name" className="inp" maxLength={60} value={cardName} disabled={busy} autoFocus onChange={(e) => setCardName(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="hit-note">메모 (나만 보임)</label>
            <input id="hit-note" className="inp" maxLength={200} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && (
            <p className="help c-neg" role="alert" data-testid="hit-error">
              {error}
            </p>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={requestClose}>
              취소
            </button>
            <button className="btn" type="submit" disabled={busy || !ok}>
              HIT 카드 기록하기
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
