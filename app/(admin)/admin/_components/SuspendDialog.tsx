"use client";

import { useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi } from "./api";
import type { SellerStatus } from "./partners";

// 이용 정지·해제 확인 창(MA-015). 정지는 사유 필수(1~200자), 해제는 사유 선택.
// 처리 중에는 닫기·취소를 막는다(요청이 끝나기 전에 닫으면 결과를 놓친다). 지금 상태가 아니면(409) 목록을 다시 읽게 알린다.
export const MAX_REASON = 200;

export function SuspendDialog({
  seller,
  onClose,
  onDone,
  onStale,
}: {
  seller: { id: string; shopName: string; status: SellerStatus };
  onClose: () => void;
  onDone: (status: SellerStatus) => void;
  onStale: () => void;
}) {
  const suspend = seller.status === "ACTIVE";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(reason);
  const tooLong = count > MAX_REASON;
  const missing = suspend && count === 0;

  const submit = async () => {
    if (busy || tooLong || missing) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ status: SellerStatus }>(`/api/admin/sellers/${seller.id}/${suspend ? "suspend" : "unsuspend"}`, {
      method: "POST",
      json: { reason: reason.trim() || undefined },
    });
    setBusy(false);
    if (r.ok) return onDone(r.data.status);
    if (r.status === 404 || r.status === 409) return onStale();
    setError(
      r.error === "reason_required"
        ? "사유를 1자 이상 200자 이하로 입력해 주십시오."
        : r.status === 403
          ? "이 작업은 최고관리자와 운영 담당만 할 수 있습니다."
          : r.status === 0
            ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오."
            : "이용 정지 또는 정지 해제를 하지 못했습니다. 잠시 후 다시 시도해 주십시오.",
    );
  };

  return (
    <Modal labelId="suspend-title" busy={busy} dirty={reason !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
        <div className="modal-h">
          <h2 className="modal-t" id="suspend-title">
            {suspend ? "이용을 정지하시겠습니까?" : "이용 정지를 해제하시겠습니까?"}
          </h2>
          <span className="t-l2 c-alt">
            {suspend ? `${seller.shopName}의 파트너스 로그인과 쇼핑몰 이용이 바로 막힙니다.` : `${seller.shopName}이(가) 바로 다시 이용할 수 있습니다.`}
          </span>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <label className="lbl" htmlFor="suspend-reason">
            {suspend ? "사유" : "사유 (선택)"}
          </label>
          <textarea id="suspend-reason" className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
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
          <button className="btn" type="button" onClick={() => void submit()} disabled={busy || tooLong || missing}>
            {busy ? "처리 중" : suspend ? "이용 정지" : "정지 해제"}
          </button>
        </div>
        </>
      )}
    </Modal>
  );
}
