"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../lib/server/authz/permissions";
import { textLength } from "../../../../lib/server/text/clean";
import { ErrorState, LoadingRows, Toast } from "../../../../components/seller/States";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi } from "./api";
import { useAdmin } from "./AdminShell";

// 파트너스 상세의 발송 잔액(GET /api/admin/sellers/{id}/message-balance, 모든 마스터 역할)과 무상 지급(POST, 최고관리자만).
// 무상 지급은 같은 창에서 다시 보내도 한 번만 지급되도록 요청 키를 창을 연 때 한 번 만들어 계속 쓴다(서버가 같은 키는 한 번만 처리).
type Balance = {
  paidBalance: number;
  freeBalance: number;
  total: number;
  lowBalanceThreshold: number;
  lowBalance: boolean;
  mail: { month: string; quota: number; sent: number; freeSent: number; chargedSent: number; pending: number; skippedBalance: number; skippedPlatformLimit: number; failed: number };
};
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Balance };
const GRANT_MAX = 10_000_000;
const REASON_MAX = 200;
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const cnt = (n: number) => `${n.toLocaleString("ko-KR")}통`;

function GrantDialog({ sellerId, onClose, onDone }: { sellerId: string; onClose: () => void; onDone: (existing: boolean) => void }) {
  const key = useRef(crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = amount.trim() === "" ? NaN : Number(amount);
  const count = textLength(reason);
  const valid = Number.isInteger(n) && n >= 1 && n <= GRANT_MAX && count >= 1 && count <= REASON_MAX;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ existing: boolean }>(`/api/admin/sellers/${sellerId}/message-balance`, { method: "POST", json: { amount: n, reason: reason.trim(), idempotencyKey: key.current } });
    setBusy(false);
    if (r.ok) return onDone(r.data.existing);
    setError(r.message ?? (r.status === 403 ? "최고관리자만 지급할 수 있습니다." : r.status === 404 ? "파트너스를 찾을 수 없습니다." : r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오." : "지급하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <Modal labelId="grant-title" busy={busy} dirty={amount !== "" || reason !== ""} onClose={onClose}>
      {(requestClose) => (
      <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <div className="modal-h">
          <h2 className="modal-t" id="grant-title">
            무상 잔액 지급
          </h2>
          <span className="t-l2 c-alt">이벤트·보상용으로 지급하며 환불 대상이 아닙니다. 유료 잔액보다 나중에 차감됩니다.</span>
        </div>
        <div className="col" style={{ gap: 14, }}>
          <div className="fld">
            <label htmlFor="grant-amount">금액</label>
            <div className="row" style={{ gap: 8 }}>
              <input id="grant-amount" className="inp" type="text" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
              <span>원</span>
            </div>
            <span className="t-c1 c-alt">1원 이상 {GRANT_MAX.toLocaleString("ko-KR")}원 이하</span>
          </div>
          <div className="fld">
            <label htmlFor="grant-reason">사유</label>
            <textarea id="grant-reason" className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
            <span className={`t-c1 ${count > REASON_MAX ? "c-neg" : "c-alt"}`}>
              {count}/{REASON_MAX}
            </span>
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
            {busy ? "지급 중" : "지급"}
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}

export function MessageBalanceSection({ sellerId }: { sellerId: string }) {
  const { me } = useAdmin();
  const canGrant = adminCan(me.role, "billing.price");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<Balance>(`/api/admin/sellers/${encodeURIComponent(sellerId)}/message-balance`);
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, [sellerId]);
  useEffect(() => void load(), [load]);

  const d = state.kind === "ok" ? state.data : null;
  return (
    <>
      <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="partner-balance">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 className="t-hl1" id="partner-balance">
            발송 잔액
          </h2>
          {canGrant && d && (
            <button className="btn btn-sm btn-out" type="button" onClick={() => setDialog(true)}>
              무상 지급
            </button>
          )}
        </div>
        {state.kind === "loading" && <LoadingRows rows={2} />}
        {state.kind === "error" && <ErrorState title="발송 잔액을 불러오지 못했습니다." onRetry={() => void load()} />}
        {d && (
          <dl className="kv">
            <dt>잔액 합계</dt>
            <dd data-testid="balance-total">
              {won(d.total)}
              {d.lowBalance && <span className="bdg b-warn" style={{ marginLeft: 8 }}>잔액 부족</span>}
            </dd>
            <dt>유료 잔액</dt>
            <dd data-testid="balance-paid">{won(d.paidBalance)}</dd>
            <dt>무상 잔액</dt>
            <dd data-testid="balance-free">{won(d.freeBalance)}</dd>
            <dt>잔액 부족 알림 기준</dt>
            <dd>{d.lowBalanceThreshold > 0 ? won(d.lowBalanceThreshold) : "정하지 않음"}</dd>
            <dt>{d.mail.month} 메일 제공량</dt>
            <dd>{cnt(d.mail.quota)}</dd>
            <dt>{d.mail.month} 보낸 메일</dt>
            <dd data-testid="balance-mail">
              {cnt(d.mail.sent)} (무료 {cnt(d.mail.freeSent)} · 차감 {cnt(d.mail.chargedSent)})
            </dd>
            <dt>잔액 부족으로 못 보낸 메일</dt>
            <dd>{cnt(d.mail.skippedBalance)}</dd>
          </dl>
        )}
      </section>
      {dialog && (
        <GrantDialog
          sellerId={sellerId}
          onClose={() => setDialog(false)}
          onDone={(existing) => {
            setDialog(false);
            setToast(existing ? "이미 지급된 요청입니다." : "무상 잔액을 지급했습니다.");
            void load();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
