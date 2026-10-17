"use client";

import { useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi, failMessage } from "./api";

// 선택한 파트너스에 같은 메모를 한 번에 남기는 확인 창(POST /api/admin/sellers/notes/bulk). 최고관리자·운영만(seller.moderate), 한 번에 1~50곳 · 메모 1~1,000자.
// 파트너스마다 따로 처리되어 일부만 실패할 수 있다(없는 파트너스 등). 결과는 onDone으로 돌려 호출한 화면이 안내한다.
const MAX_BODY = 1000;
export type BulkNoteResult = { created: number; failed: number };

export function BulkNoteDialog({ sellerIds, onClose, onDone }: { sellerIds: string[]; onClose: () => void; onDone: (r: BulkNoteResult) => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(body);
  const invalid = count === 0 || count > MAX_BODY;

  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ created: number; results: { sellerId: string; ok: boolean; error?: string }[] }>("/api/admin/sellers/notes/bulk", { method: "POST", json: { sellerIds, body: body.trim() } });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? failMessage(r, "메모를 남기지 못했습니다. 잠시 후 다시 시도해 주십시오."));
    onDone({ created: r.data.created, failed: r.data.results.filter((x) => !x.ok).length });
  };

  return (
    <Modal labelId="bulk-note-title" busy={busy} dirty={body !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="bulk-note-title">
              선택한 {sellerIds.length}곳에 메모를 남기시겠습니까?
            </h2>
            <span className="t-l2 c-alt">같은 메모가 각 파트너스의 메모 탭에 남고 로그 추적에 기록됩니다. 파트너스에게는 보이지 않습니다.</span>
          </div>
          <div className="col" style={{ gap: 6, padding: "0 24px" }}>
            <label className="lbl" htmlFor="bulk-note-body">
              메모
            </label>
            <textarea id="bulk-note-body" className="inp" rows={4} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
            <span className={`t-c1 ${count > MAX_BODY ? "c-neg" : "c-alt"}`}>
              {count.toLocaleString("ko-KR")}/{MAX_BODY.toLocaleString("ko-KR")}
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
              {busy ? "처리 중" : "메모 남기기"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
