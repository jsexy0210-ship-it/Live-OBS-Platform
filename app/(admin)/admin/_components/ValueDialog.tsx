"use client";

import { useState } from "react";
import { Modal } from "../../../../components/admin-ui";
import { adminApi } from "./api";
import { effectiveAtIso } from "./messageFees";

// 숫자 하나(단가·월 제공량)를 바꾸는 확인 창. 적용 예정 시각(KST)을 비우면 바로 적용한다. 처리 중에는 닫기·취소를 막는다.
// 공통 모달(X·Esc·바깥 클릭=취소, 값을 바꿨으면 닫기 전에 확인).
// 서버가 거절하면 이유를 안내한다(400·404·403은 서버 문구 또는 기본 문구).
export function ValueDialog({
  title,
  label,
  unit,
  current,
  max,
  path,
  field,
  onClose,
  onDone,
}: {
  title: string;
  label: string;
  unit: string;
  current: number;
  max: number;
  path: string;
  field: "unitPrice" | "monthlyQuota";
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(String(current));
  const [at, setAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = value.trim() === "" ? NaN : Number(value);
  const valid = Number.isInteger(n) && n >= 0 && n <= max;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(path, { method: "POST", json: { [field]: n, ...(effectiveAtIso(at) ? { effectiveAt: effectiveAtIso(at) } : {}) } });
    setBusy(false);
    if (r.ok) return onDone();
    setError(r.message ?? (r.status === 403 ? "최고관리자만 바꿀 수 있습니다." : r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오." : "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <Modal labelId="value-title" busy={busy} dirty={value !== String(current) || at !== ""} onClose={onClose}>
      {(requestClose) => (
        <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
          <div className="modal-h">
            <h2 className="modal-t" id="value-title">
              {title}
            </h2>
          </div>
          <div className="col" style={{ gap: 16 }}>
            <div className="fld">
              <label htmlFor="value-input">{label}</label>
              <div className="row" style={{ gap: 8 }}>
                <input id="value-input" className="inp" type="text" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} />
                <span>{unit}</span>
              </div>
              {!valid && <span className="t-c1 c-neg">0 이상 {max.toLocaleString("ko-KR")} 이하 숫자만 입력해 주십시오.</span>}
            </div>
            <div className="fld">
              <label htmlFor="value-at">바뀌는 시각</label>
              <input id="value-at" className="inp" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} disabled={busy} />
              <span className="t-c1 c-alt">한국 시간 기준입니다. 비워 두면 바로 적용합니다.</span>
            </div>
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
            <button className="btn" type="submit" disabled={!valid || busy}>
              {busy ? "저장 중" : "저장"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
