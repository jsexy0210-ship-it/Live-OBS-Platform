"use client";

import { useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi, failMessage } from "./api";
import { MAX_REASON } from "./SuspendDialog";

// 가입 신청 반려 창(MA-013 목록·MA-014 상세 공용, POST /api/admin/sellers/{id}/reject). 사유는 자주 쓰는 문구를 고르고 추가 안내를 덧붙일 수 있다. 합쳐서 1~200자.
// 처리 중에는 닫기를 막고, 이미 처리됐으면(404·409) onStale로 알린다.
const PRESETS = ["사업자 상태가 휴업 · 폐업입니다", "서류와 신청 정보가 다릅니다", "통신판매업을 신고하지 않았습니다", "취급 품목이 이용약관에 맞지 않습니다"];
const join = (preset: string, extra: string) => [preset, extra.trim()].filter(Boolean).join(" · ");

export function RejectApplicationDialog({ id, shopName, onClose, onDone, onStale }: { id: string; shopName: string; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const [preset, setPreset] = useState("");
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = join(preset, extra);
  const count = textLength(reason);
  const invalid = count === 0 || count > MAX_REASON;
  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/sellers/${id}/reject`, { method: "POST", json: { reason } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 404 || r.status === 409) return onStale();
    setError(r.error === "reason_required" ? "사유를 1자 이상 200자 이하로 입력해 주십시오." : failMessage(r, "처리하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="reject-title" busy={busy} dirty={preset !== "" || extra !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="reject-title">
              가입을 반려하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">{shopName}의 가입 신청이 반려되며, 같은 대표자가 다시 신청할 수 있습니다.</span>
          </div>
          <div className="col" style={{ gap: 6, padding: "0 24px" }}>
            <label className="lbl" htmlFor="reject-preset">
              반려 사유
            </label>
            <select id="reject-preset" className="inp" value={preset} onChange={(e) => setPreset(e.target.value)} disabled={busy}>
              <option value="">사유 선택</option>
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <textarea id="reject-reason" className="inp" rows={3} aria-label="추가 안내" placeholder="추가 안내 (사유를 고르지 않았다면 직접 입력)" value={extra} onChange={(e) => setExtra(e.target.value)} disabled={busy} />
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
              {busy ? "처리 중" : "반려"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
