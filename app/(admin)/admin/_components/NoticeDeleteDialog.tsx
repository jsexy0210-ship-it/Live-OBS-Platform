"use client";
import { useState } from "react";
import { Modal } from "../../../../components/admin-ui";
import { adminApi, failMessage } from "./api";
import type { Notice } from "./notices";
export function NoticeDeleteDialog({ notice, onClose, onDone, onStale }: { notice: Notice; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/platform-notices/${notice.id}?expectedVersion=${notice.version}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 409 || r.status === 404) return onStale();
    setError(failMessage(r, "삭제하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="notice-del-title" busy={busy} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="notice-del-title">
              「{notice.title}」을(를) 삭제하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">삭제한 공지는 어디에도 보이지 않으며, 로그 추적에만 남습니다.</span>
          </div>
          {error && (
            <div style={{ padding: "0 24px" }}>
              <span className="err" role="alert">
                {error}
              </span>
            </div>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy}>
              {busy ? "처리 중" : "삭제"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

