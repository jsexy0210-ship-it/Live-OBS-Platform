"use client";

import { useState } from "react";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi } from "./api";
import { TRIAL_LIMIT_MAX, type AdminPlan } from "./messageFees";

// 체험하기 한도 변경(MA-022, 최고관리자·운영 담당). 알림톡·문자 건수, 구매자 휴대폰 본인확인 건수, 저장 용량(MB).
const FIELDS = [
  { key: "message", label: "알림톡·문자", unit: "건" },
  { key: "identity", label: "구매자 본인확인", unit: "건" },
  { key: "storageMb", label: "저장 용량", unit: "MB" },
] as const;
type Key = (typeof FIELDS)[number]["key"];

export function PlanTrialDialog({ plan, onClose, onDone }: { plan: AdminPlan; onClose: () => void; onDone: () => void }) {
  const before: Record<Key, number> = { message: plan.trialMessageLimit, identity: plan.trialIdentityLimit, storageMb: plan.trialStorageMb };
  const [v, setV] = useState<Record<Key, string>>({ message: String(before.message), identity: String(before.identity), storageMb: String(before.storageMb) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = (k: Key) => (v[k].trim() === "" ? NaN : Number(v[k]));
  const ok = (k: Key) => Number.isInteger(n(k)) && n(k) >= 0 && n(k) <= TRIAL_LIMIT_MAX;
  const valid = FIELDS.every((f) => ok(f.key));
  const changed = FIELDS.some((f) => n(f.key) !== before[f.key]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || !changed || busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/plans/${plan.code}/trial-limits`, { method: "POST", json: { message: n("message"), identity: n("identity"), storageMb: n("storageMb") } });
    setBusy(false);
    if (r.ok) return onDone();
    setError(r.status === 403 ? "이 작업은 최고관리자와 운영 담당만 할 수 있습니다." : r.status === 404 ? "요금제를 찾을 수 없습니다. 목록을 새로 불러와 주십시오." : r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오." : "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
  };

  return (
    <Modal labelId="plan-trial-title" busy={busy} dirty={changed} onClose={onClose}>
      {(requestClose) => (
        <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
          <div className="modal-h">
            <h2 className="modal-t" id="plan-trial-title">
              {plan.name} 체험 한도 변경
            </h2>
          </div>
          <div className="col" style={{ gap: 16 }}>
            {FIELDS.map((f) => (
              <div className="fld" key={f.key}>
                <label htmlFor={`trial-${f.key}`}>{f.label}</label>
                <div className="row" style={{ gap: 8 }}>
                  <input id={`trial-${f.key}`} className="inp" type="text" inputMode="numeric" value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} disabled={busy} />
                  <span>{f.unit}</span>
                </div>
                {!ok(f.key) && <span className="t-c1 c-neg">0 이상 {TRIAL_LIMIT_MAX.toLocaleString("ko-KR")} 이하의 정수로 입력해 주십시오.</span>}
              </div>
            ))}
            <span className="t-c1 c-alt">체험하기 중인 파트너스에만 적용됩니다. 바로 적용됩니다.</span>
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
            <button className="btn" type="submit" disabled={!valid || !changed || busy}>
              {busy ? "저장 중" : "저장"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
