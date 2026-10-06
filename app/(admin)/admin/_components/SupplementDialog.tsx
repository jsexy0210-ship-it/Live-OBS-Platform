"use client";

import { useState } from "react";
import { Modal } from "../../../../components/admin-ui";
import { adminApi, failMessage } from "./api";

// 보완 요청 창(MA-013 검토 패널 · MA-014 상세 공용): 사유 1~200자를 신청자에게 메일로 보내고 7일 안에 응답이 없으면 자동 반려된다.
const MAX_REASON = 200;

export function SupplementDialog({ row, onClose, onDone, onStale }: { row: { id: string; shopName: string }; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = reason.trim().length;
  const invalid = count === 0 || count > MAX_REASON;
  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/sellers/${encodeURIComponent(row.id)}/supplement`, { method: "POST", json: { reason: reason.trim() } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 404) return onStale();
    setError(failMessage(r, "보완 요청을 하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="supplement-title" busy={busy} dirty={reason !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="supplement-title">
              보완을 요청하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">{row.shopName} 신청자에게 사유가 그대로 발송되고, 7일 안에 보완하지 않으면 자동 반려됩니다.</span>
          </div>
          <div className="col" style={{ gap: 6, padding: "0 24px" }}>
            <textarea className="inp" rows={3} aria-label="보완 요청 사유" placeholder="보완 요청 내용 입력" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
            <span className={`t-c1 ${count > MAX_REASON ? "c-neg" : "c-alt"}`}>
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
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy || invalid}>
              {busy ? "처리 중" : "보완 요청"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
