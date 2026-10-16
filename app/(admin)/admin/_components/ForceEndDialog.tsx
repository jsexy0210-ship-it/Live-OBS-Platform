"use client";

import { useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi } from "./api";
import { MAX_REASON } from "./SuspendDialog";

// 방송 강제 종료 확인 창(MA-041, DS-CONFIRM ④ 위험). 사유 필수(1~200자). POST /api/admin/ops/live-broadcasts/{id}/end (운영·최고관리자만).
// 이미 끝난 방송(409)·없는 방송(404)이면 창을 닫고 목록만 새로 읽게 한다. 처리 중에는 닫기를 막는다.
export function ForceEndDialog({
  broadcast,
  onClose,
  onDone,
  onStale,
}: {
  broadcast: { broadcastId: string; shopName: string; title: string | null };
  onClose: () => void;
  onDone: () => void;
  onStale: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(reason.trim());
  const tooLong = count > MAX_REASON;
  const missing = count === 0;

  const submit = async () => {
    if (busy || tooLong || missing) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/ops/live-broadcasts/${broadcast.broadcastId}/end`, { method: "POST", json: { reason: reason.trim() } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 404 || r.status === 409) return onStale();
    setError(
      r.error === "reason_required"
        ? "사유를 1자 이상 200자 이하로 입력해 주십시오."
        : r.status === 403
          ? "이 작업은 최고관리자와 운영 담당만 할 수 있습니다."
          : r.status === 0
            ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오."
            : "방송을 종료하지 못했습니다. 잠시 후 다시 시도해 주십시오.",
    );
  };

  return (
    <Modal labelId="force-end-title" busy={busy} dirty={reason !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="force-end-title">
              「{broadcast.shopName}{broadcast.title ? ` · ${broadcast.title}` : ""}」 방송을 강제 종료하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">LIVE 상태를 종료로 바꿉니다 · 개봉 중인 주문대기 항목은 그대로 둡니다 · 사유는 로그 추적에 남습니다</span>
          </div>
          <div className="col" style={{ gap: 6 }}>
            <label className="lbl" htmlFor="force-end-reason">
              사유 (필수)
            </label>
            <textarea id="force-end-reason" className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
            <span className={`t-c1 ${tooLong ? "c-neg" : "c-alt"}`}>
              {count}/{MAX_REASON}
            </span>
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn btn-neg" type="button" onClick={() => void submit()} disabled={busy || tooLong || missing}>
              {busy ? "처리 중" : "강제 종료"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
