"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { textLength } from "../../../../../../../lib/server/text/clean";
import { Modal, PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { PAYMENT_KIND, safeUrl } from "../../../../_components/payments";
import { day, dayTime, won } from "../../../../_components/partners";
import { REFUND_SOURCE, REFUND_STATUS, refundReason, type Refund } from "../../../../_components/refunds";

// MA-027 환불 처리(GET /api/admin/subscription-refunds/{id}, 승인·거절). 승인·거절은 최고관리자만(billing.refund).
// 승인 결과: 환불 완료 / 실패(실패 사유를 보이고 다시 승인 가능) / 처리 중(응답이 끊긴 경우, 다시 승인하면 같은 환불로 한 번만 처리).
// 다른 곳에서 먼저 처리했으면(409) 최신 상태를 다시 읽는다. 같은 청구에 이미 새 요청이 있으면(409 already_requested) 목록으로 안내한다.
const MAX_NOTE = 200;
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; refund: Refund };

function RejectModal({ refund, onClose, onDone, onStale }: { refund: Refund; onClose: () => void; onDone: (r: Refund) => void; onStale: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(note);
  const invalid = count === 0 || count > MAX_NOTE;
  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ refund: Refund }>(`/api/admin/subscription-refunds/${refund.id}/reject`, { method: "POST", json: { note: note.trim(), expectedVersion: refund.version } });
    setBusy(false);
    if (r.ok) return onDone(r.data.refund);
    if (r.status === 409 || r.status === 404) return onStale();
    setError(r.message ?? failMessage(r, "환불 처리를 하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="refund-reject-title" busy={busy} dirty={count > 0} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="refund-reject-title">
              환불 요청을 거절하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">{refund.shopName}의 {won(refund.amount)} 환불 요청이 거절됩니다. 거절 사유는 로그 추적에 남습니다.</span>
          </div>
          <div className="col" style={{ gap: 6, padding: "0 24px" }}>
            <label className="lbl" htmlFor="refund-note">
              거절 사유
            </label>
            <textarea id="refund-note" className="inp" rows={3} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
            <span className={`t-c1 ${count > MAX_NOTE ? "c-neg" : "c-alt"}`}>
              {count}/{MAX_NOTE}
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
              {busy ? "처리 중" : "거절"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Info({ title, id, rows }: { title: string; id: string; rows: [string, React.ReactNode][] }) {
  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby={id}>
      <h2 className="t-hl1" id={id}>
        {title}
      </h2>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function RefundDetailPage() {
  const { refundId } = useParams<{ refundId: string }>();
  const { me } = useAdmin();
  const canApprove = adminCan(me.role, "billing.refund");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [confirmed, setConfirmed] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [approving, setApproving] = useState(false);
  const [reject, setReject] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ refund: Refund }>(`/api/admin/subscription-refunds/${encodeURIComponent(refundId)}`);
    setState(r.ok ? { kind: "ok", refund: r.data.refund } : { kind: "error", status: r.status });
  }, [refundId]);
  useEffect(() => void load(), [load]);

  const stale = () => {
    setReject(false);
    setConfirmed(false);
    setToast({ text: "다른 곳에서 먼저 처리했습니다. 최신 상태를 불러옵니다.", neg: true });
    void load();
  };
  const approve = async (refund: Refund) => {
    if (approving || !confirmed) return;
    setApproving(true);
    const r = await adminApi<{ refund: Refund }>(`/api/admin/subscription-refunds/${refund.id}/approve`, {
      method: "POST",
      json: { expectedVersion: refund.version, ...(approveNote.trim() ? { note: approveNote.trim() } : {}) },
    });
    setApproving(false);
    setConfirmed(false);
    if (r.ok) {
      const next = r.data.refund;
      setState({ kind: "ok", refund: next });
      setToast(
        next.status === "REFUNDED"
          ? { text: `${won(next.amount)}을 환불했습니다.` }
          : next.status === "FAILED"
            ? { text: "카드 결제 취소가 안 됐습니다. 아래 이유를 확인한 뒤 「다시 승인」을 눌러 주십시오.", neg: true }
            : { text: "취소 요청은 보냈지만 결과를 아직 모릅니다. 「다시 승인」을 눌러도 같은 환불은 한 번만 처리됩니다.", neg: true },
      );
      return;
    }
    if (r.error === "already_requested") {
      setToast({ text: r.message ?? "이 청구에는 이미 환불 요청이 있습니다", neg: true });
      return void load();
    }
    if (r.status === 409 || r.status === 404) return stale();
    setToast({ text: r.message ?? failMessage(r, "승인하지 못했습니다. 잠시 후 다시 시도해 주십시오."), neg: true });
  };

  const rf = state.kind === "ok" ? state.refund : null;
  const open = rf && (rf.status === "REQUESTED" || rf.status === "FAILED" || rf.status === "PROCESSING");
  const receipt = safeUrl(rf?.payment.receiptUrl ?? null);

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 환불 요청 › 환불 처리" />
      <main className="main">
        <PageHead
          title={rf ? `환불 처리 · ${rf.shopName}` : "환불 처리"}
          actions={
            <Link className="btn btn-out" href="/admin/billing/refunds">
              목록
            </Link>
          }
        />
        {!rf ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">환불 요청을 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="환불 요청을 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <div className="card pad row" style={{ gap: 8, flexWrap: "wrap" }} data-testid="refund-status">
              <span className={`bdg ${REFUND_STATUS[rf.status].cls}`}>{REFUND_STATUS[rf.status].label}</span>
              <span className="t-l2 c-alt">요청 {dayTime(rf.createdAt)}</span>
            </div>
            {rf.status === "FAILED" && rf.failureReason && (
              <div className="card pad c-neg" role="alert" data-testid="refund-failure">
                카드 결제 취소가 안 됐습니다. 이유: {rf.failureReason}. 잠시 뒤 「다시 승인」을 눌러 주십시오.
              </div>
            )}
            {rf.status === "PROCESSING" && (
              <div className="card pad" role="status">
                결제 취소 요청을 보냈지만 결과를 확인하지 못했습니다. 다시 승인하면 같은 환불로 한 번만 처리합니다.
              </div>
            )}
            <Info
              title="요청 내용"
              id="refund-request"
              rows={[
                ["파트너스", <Link key="s" className="fw6" href={`/admin/partners/${rf.sellerId}`}>{rf.shopName}</Link>],
                ["요청한 곳", REFUND_SOURCE[rf.source]],
                ["사유", refundReason(rf.reason)],
                ["요청 금액", <b key="a">{won(rf.amount)}</b>],
                ...(rf.decisionNote ? ([["처리 메모", rf.decisionNote]] as [string, React.ReactNode][]) : []),
                ...(rf.decidedAt ? ([["처리 시각", dayTime(rf.decidedAt)]] as [string, React.ReactNode][]) : []),
                ...(rf.refundedAt ? ([["환불 시각", dayTime(rf.refundedAt)]] as [string, React.ReactNode][]) : []),
              ]}
            />
            <Info
              title="환불 대상 청구"
              id="refund-payment"
              rows={[
                ["청구", `${PAYMENT_KIND[rf.payment.kind]} · ${day(rf.payment.periodStart)} ~ ${day(rf.payment.periodEnd)}`],
                ["결제 금액", won(rf.payment.amount)],
                ["결제일", dayTime(rf.payment.paidAt)],
                ["카드 매출전표", receipt ? <a key="r" className="fw6" href={receipt} target="_blank" rel="noopener noreferrer">보기</a> : "-"],
                ["청구 내역", <Link key="p" className="fw6" href={`/admin/billing/invoices?sellerId=${rf.sellerId}`}>청구·결제 내역에서 보기</Link>],
              ]}
            />
            {open && (
              <section className="card pad-l col" style={{ gap: 12 }} aria-labelledby="refund-act">
                <h2 className="t-hl1" id="refund-act">
                  승인 · 거절
                </h2>
                {canApprove ? (
                  <>
                    <div className="card pad" role="note">
                      승인하면 카드 결제 취소를 바로 요청합니다. 요청한 뒤에는 되돌릴 수 없습니다.
                    </div>
                    <label className="lbl" htmlFor="refund-approve-note">
                      처리 메모 (선택)
                    </label>
                    <input id="refund-approve-note" className="inp" maxLength={MAX_NOTE} value={approveNote} onChange={(e) => setApproveNote(e.target.value)} disabled={approving} />
                    <label className="chk">
                      <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={approving} />
                      내용을 확인했고 환불을 승인합니다
                    </label>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn" type="button" onClick={() => void approve(rf)} disabled={!confirmed || approving}>
                        {approving ? "처리 중" : rf.status === "FAILED" || rf.status === "PROCESSING" ? "다시 승인하고 카드 결제 취소" : "환불 승인하고 카드 결제 취소"}
                      </button>
                      {rf.status !== "PROCESSING" && (
                        <button className="btn btn-out" type="button" onClick={() => setReject(true)} disabled={approving}>
                          거절
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="t-b2" style={{ margin: 0 }}>
                      승인·거절은 최고관리자만 할 수 있습니다.
                    </p>
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </main>
      {reject && rf && (
        <RejectModal
          refund={rf}
          onClose={() => setReject(false)}
          onDone={(next) => {
            setReject(false);
            setState({ kind: "ok", refund: next });
            setToast({ text: "환불 요청을 거절했습니다." });
          }}
          onStale={stale}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
