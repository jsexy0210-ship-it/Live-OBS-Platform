"use client";

import { useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi, failMessage } from "./api";

// 대리 조회 시작 확인 창(MA-016, POST /api/admin/sellers/{id}/impersonate). 사유 필수(1~200자). 성공하면 읽기 전용 파트너스 화면(/seller)을 새 창으로 연다(30분).
// 팝업 차단을 피하려고 새 창은 누르는 순간 먼저 열고, 요청이 성공하면 주소를 넣고 실패하면 닫는다.
const MAX_REASON = 200;
export type ImpersonationStart = { expiresAt: string; opened: boolean };

export function ImpersonateDialog({ seller, onClose, onDone }: { seller: { id: string; shopName: string }; onClose: () => void; onDone: (r: ImpersonationStart) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(reason);
  const invalid = count === 0 || count > MAX_REASON;

  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const win = window.open("", "_blank");
    const r = await adminApi<{ expiresAt: string }>(`/api/admin/sellers/${seller.id}/impersonate`, { method: "POST", json: { reason: reason.trim() } });
    setBusy(false);
    if (r.ok) {
      if (win) win.location.href = "/seller";
      return onDone({ expiresAt: r.data.expiresAt, opened: !!win });
    }
    win?.close();
    setError(
      r.error === "reason_required"
        ? "사유를 1자 이상 200자 이하로 입력해 주십시오."
        : r.error === "seller_not_viewable"
          ? "이 파트너스 화면은 지금 대신 볼 수 없습니다."
          : r.status === 404
            ? "파트너스를 찾을 수 없습니다."
            : r.status === 403
              ? "대신 보기는 최고관리자·운영·고객 지원 담당만 할 수 있습니다."
              : (r.message ?? failMessage(r, "시작하지 못했습니다. 잠시 후 다시 시도해 주십시오.")),
    );
  };

  return (
    <Modal labelId="impersonate-title" busy={busy} dirty={reason !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="impersonate-title">
              이 파트너스 화면을 대신 보시겠습니까?
            </h2>
            <span className="t-l2 c-alt">{seller.shopName}의 파트너스 화면을 30분 동안 읽기 전용으로 봅니다. 사유는 로그 추적에 남습니다.</span>
          </div>
          <div className="col" style={{ gap: 6, padding: "0 24px" }}>
            <label className="lbl" htmlFor="impersonate-reason">
              사유
            </label>
            <textarea id="impersonate-reason" className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
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
              {busy ? "처리 중" : "대신 보기 시작"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
