"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "../../admin-ui";
import { api } from "../api";
import { memberDay } from "./types";

// SA-042 회원 상세의 구매 제한 현황과 풀기(SA-043과 같은 API). 지금 주문이 막혀 있으면 사유·기간을 보이고 「제한 풀기」를 연다.
// API: GET /api/seller/purchase-restrictions(전체 중 이 회원 것만 고름), POST …/{buyerMemberId}/lift { reason? }(회원·적립금 권한).
type Restriction = { id: string; buyerMemberId: string; reason: string; startsAt: string; endsAt: string };
const REASON: Record<string, string> = { UNPAID_AUTO_CANCEL: "미입금 자동 취소 반복", PAID_CANCEL: "결제 후 취소 반복" };

export function MemberRestriction({ memberId, onChanged }: { memberId: string; onChanged: (text: string) => void | Promise<void> }) {
  const [rows, setRows] = useState<Restriction[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [lifting, setLifting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ restrictions: Restriction[] }>("/api/seller/purchase-restrictions");
    if (!r.ok) return setFailed(true);
    setFailed(false);
    setRows(r.data.restrictions.filter((x) => x.buyerMemberId === memberId));
  }, [memberId]);
  useEffect(() => {
    void load();
  }, [load]);

  const lift = async () => {
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/purchase-restrictions/${memberId}/lift`, { method: "POST", body: { reason: reason.trim() || undefined } });
    setBusy(false);
    if (!r.ok && r.status !== 404) return setError(r.message ?? "제한을 풀지 못했습니다. 잠시 후 다시 시도해 주십시오");
    setLifting(false);
    setReason("");
    await load();
    await onChanged(r.ok ? "구매 제한을 풀었습니다" : "이미 풀린 제한입니다");
  };

  const ends = rows && rows.length > 0 ? rows.reduce((a, b) => (a > b.endsAt ? a : b.endsAt), rows[0].endsAt) : null;

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-restriction">
      <h2 className="t-hl1" id="member-restriction">
        구매 제한
      </h2>
      {failed && (
        <div className="row" style={{ gap: 8 }}>
          <span className="t-l2 c-alt">구매 제한 정보를 불러오지 못했습니다.</span>
          <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      )}
      {rows && rows.length === 0 && <span className="t-l2" data-testid="restriction-none">제한 없음 · 주문할 수 있습니다</span>}
      {rows && rows.length > 0 && (
        <>
          <dl className="kv" data-testid="restriction-info">
            <dt>사유</dt>
            <dd>{[...new Set(rows.map((x) => REASON[x.reason] ?? x.reason))].join(" · ")}</dd>
            <dt>제한 시작</dt>
            <dd className="num">{memberDay(rows.reduce((a, b) => (a < b.startsAt ? a : b.startsAt), rows[0].startsAt))}</dd>
            <dt>제한 종료</dt>
            <dd className="num">{memberDay(ends)}</dd>
          </dl>
          <div className="row">
            <button className="btn btn-out" type="button" onClick={() => setLifting(true)}>
              제한 풀기
            </button>
          </div>
        </>
      )}
      {lifting && (
        <Modal labelId="mr-lift-title" busy={busy} dirty={reason !== ""} onClose={() => setLifting(false)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mr-lift-title">
              구매 제한을 푸시겠습니까?
            </h2>
          </div>
          <div className="col" style={{ gap: 10, padding: "0 20px" }}>
            <p className="t-l2">풀면 이 회원이 바로 주문할 수 있고, 자동 취소 횟수는 새로 셉니다.</p>
            <div className="fld">
              <label htmlFor="mr-lift-reason">사유</label>
              <textarea id="mr-lift-reason" className="inp" style={{ height: 80, padding: "10px 12px" }} maxLength={200} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="예: 입금 확인 후 해제" />
            </div>
            {error && (
              <div className="msg msg-neg" role="alert">
                <span>{error}</span>
              </div>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setLifting(false)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void lift()}>
              {busy ? "처리 중" : "제한 풀기"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
