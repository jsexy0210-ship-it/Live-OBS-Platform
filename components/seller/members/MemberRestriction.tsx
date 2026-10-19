"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "../../admin-ui";
import { api, failMessage } from "../api";
import { textLength } from "../format";
import { useLatestResponse } from "../latestResponse";
import { useSeller } from "../SellerShell";
import { confirmLeave, useUnsavedGuard } from "../../../lib/client/navigation";
import { memberDay } from "./types";

// SA-042 회원 상세의 구매 제한 현황·직접 걸기·풀기(SA-043과 같은 API). 지금 주문이 막혀 있으면 사유·기간을 보이고 「제한 풀기」를 연다. 막혀 있지 않으면 「직접 제한」을 걸 수 있다.
// API: GET /api/seller/purchase-restrictions?buyerMemberId=(이 회원의 활성 제한), POST …/{buyerMemberId} { days?, note? }(직접 제한), POST …/{buyerMemberId}/lift { reason? }(회원·적립금 권한).
// 서버 필터가 없던 때의 응답(전체 최근 200건)에 섞여 와도 이 회원 것만 쓰도록 한 번 더 거른다.
type Restriction = { id: string; buyerMemberId: string; reason: string; note?: string | null; startsAt: string; endsAt: string };
const REASON: Record<string, string> = { UNPAID_AUTO_CANCEL: "미입금 자동 취소 반복", PAID_CANCEL: "결제 후 취소 반복", MANUAL: "직접 제한" };

export function MemberRestriction({ memberId, nickname = null, onChanged }: { memberId: string; nickname?: string | null; onChanged: (text: string) => void | Promise<void> }) {
  const { can, me } = useSeller();
  const canEdit = can("MEMBER_POINTS") && !me.readOnly;
  const reads = useLatestResponse();
  const [stale, setStale] = useState(false);
  const [rows, setRows] = useState<Restriction[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [lifting, setLifting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const [days, setDays] = useState("30");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const request = reads.next();
    const r = await api<{ restrictions: Restriction[] }>(`/api/seller/purchase-restrictions?buyerMemberId=${memberId}`);
    if (!r.ok) { if (reads.failMatters(request)) { setFailed(true); if (r.status === 401 || r.status === 403) setRows(null); } return false; }
    if (reads.accept(request) === "apply") { setFailed(false); setStale(false); setRows(r.data.restrictions.filter((row) => row.buyerMemberId === memberId)); }
    return true;
  }, [memberId, reads]);
  useEffect(() => { void load(); }, [load]);
  const lifted = async (already: boolean) => {
    setLifting(false);
    reads.confirmChange();
    if (!already) setRows([]);
    const refreshed = await load();
    if (!refreshed) setStale(true);
    const result = already ? "이미 풀렸거나 기간이 끝난 제한입니다" : `${nickname ?? "구매자"}의 구매 제한을 풀었습니다`;
    await onChanged(refreshed ? result : `${result} · 목록을 새로 불러오지 못했습니다`);
  };

  const addRestriction = async () => {
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/purchase-restrictions/${memberId}`, { method: "POST", body: { days: Number(days), ...(note.trim() ? { note: note.trim() } : {}) } });
    setBusy(false);
    if (!r.ok) {
      if (r.error === "already_restricted") void load();
      return setError(r.message ?? "제한을 걸지 못했습니다. 잠시 후 다시 시도해 주십시오");
    }
    reads.confirmChange();
    setAdding(false);
    setNote("");
    setDays("30");
    await load();
    await onChanged("구매 제한을 걸었습니다");
  };
  const daysOk = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 365;

  const ends = rows && rows.length > 0 ? rows.reduce((a, b) => (a > b.endsAt ? a : b.endsAt), rows[0].endsAt) : null;

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-restriction">
      <h2 className="t-hl1" id="member-restriction">
        구매 제한
      </h2>
      {stale && <p className="msg msg-cau" role="status">목록이 최신이 아닐 수 있습니다.</p>}
      {failed && (
        <div className="row" style={{ gap: 8 }}>
          <span className="t-l2 c-alt">구매 제한 정보를 불러오지 못했습니다.</span>
          <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      )}
      {rows && rows.length === 0 && (
        <>
          <span className="t-l2" data-testid="restriction-none">제한 없음 · 주문할 수 있습니다</span>
          {canEdit && <div className="row">
            <button className="btn btn-out" type="button" onClick={() => setAdding(true)}>
              직접 제한
            </button>
          </div>}
        </>
      )}
      {rows && rows.length > 0 && (
        <>
          <dl className="kv" data-testid="restriction-info">
            <dt>사유</dt>
            <dd>{[...new Set(rows.map((x) => REASON[x.reason] ?? x.reason))].join(" · ")}</dd>
            <dt>제한 시작</dt>
            <dd className="num">{memberDay(rows.reduce((a, b) => (a < b.startsAt ? a : b.startsAt), rows[0].startsAt))}</dd>
            <dt>제한 종료</dt>
            <dd className="num">{memberDay(ends)}</dd>
            {rows.some((x) => x.note) && (
              <>
                <dt>메모</dt>
                <dd style={{ whiteSpace: "pre-wrap" }}>{rows.filter((x) => x.note).map((x) => x.note).join("\n")}</dd>
              </>
            )}
          </dl>
          {canEdit && <div className="row">
            <button className="btn btn-out" type="button" onClick={() => setLifting(true)}>
              제한 풀기
            </button>
          </div>}
        </>
      )}
      {adding && (
        <Modal labelId="mr-add-title" busy={busy} dirty={note !== "" || days !== "30"} onClose={() => setAdding(false)}>
          <div className="modal-h">
            <h2 className="modal-t" id="mr-add-title">
              주문을 막으시겠습니까?
            </h2>
          </div>
          <div className="col" style={{ gap: 12, padding: "0 20px" }}>
            <p className="t-l2">제한 기간 동안 이 회원은 주문할 수 없습니다. 직접 제한을 걸거나 풀면 그 시점부터 미입금 자동 취소 횟수를 새로 셉니다.</p>
            <div className="fld">
              <label htmlFor="mr-days" className="req">
                제한 기간(일)
              </label>
              <input id="mr-days" className="inp" inputMode="numeric" value={days} disabled={busy} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ""))} />
              <span className="help">1~365일</span>
            </div>
            <div className="fld">
              <label htmlFor="mr-note">사유</label>
              <textarea id="mr-note" className="inp" style={{ height: 80, padding: "10px 12px" }} maxLength={200} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="예: 반복 허위 주문" />
            </div>
            {error && (
              <div className="msg msg-neg" role="alert">
                <span>{error}</span>
              </div>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setAdding(false)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy || !daysOk} onClick={() => void addRestriction()}>
              {busy ? "처리 중" : "제한 걸기"}
            </button>
          </div>
        </Modal>
      )}
      {lifting && canEdit && <RestrictionLiftForm memberId={memberId} nickname={nickname} onClose={() => setLifting(false)} onDone={() => void lifted(false)} onGone={() => void lifted(true)} />}
    </section>
  );
}

const MAX_REASON = 200;

function RestrictionLiftForm({ memberId, nickname, onClose, onDone, onGone }: { memberId: string; nickname: string | null; onClose: () => void; onDone: () => void; onGone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 글자 수는 서버와 같은 기준(NFKC 정규화·앞뒤 공백 제외·코드 포인트)으로 센다
  const count = textLength(reason);
  const tooLong = count > MAX_REASON;
  const releaseGuard = useUnsavedGuard(reason !== "");
  const cancel = async () => { if (!confirmLeave(reason !== "")) return; setBusy(true); await releaseGuard(); onClose(); };

  const submit = async () => {
    if (tooLong || busy) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/purchase-restrictions/${memberId}/lift`, { method: "POST", body: { reason: reason.trim() || undefined } });
    if (r.ok) { await releaseGuard(); return onDone(); }
    // 404: 그사이 기간이 끝났거나 다른 사람이 이미 풀었다. 목록을 다시 읽어 맞춘다.
    if (r.status === 404) { await releaseGuard(); return onGone(); }
    setBusy(false);
    setError(
      r.error === "invalid_reason"
        ? "사유에 쓸 수 없는 글자가 있습니다"
        : r.status === 403 && r.error === "plan_feature_required"
          ? "지금 요금제에서 사용할 수 없는 기능입니다"
          : failMessage(r, "admin"),
    );
  };

  return (
    <section className="col" style={{ gap: 12 }} aria-labelledby="pr-lift-title">
      <div className="col" style={{ gap: 12 }}>
        <div className="col" style={{ gap: 6 }}>
          <h2 className="t-h2" id="pr-lift-title">
            구매 제한을 푸시겠습니까?
          </h2>
          <span className="t-l2 c-alt">{nickname ?? "이 구매자"}님이 바로 다시 주문할 수 있습니다. 자동 제한 횟수는 지금부터 새로 셉니다.</span>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <label className="lbl" htmlFor="pr-lift-reason">
            사유 (선택)
          </label>
          <textarea id="pr-lift-reason" className="inp" rows={3} disabled={busy} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 입금 확인 후 해제" />
          <span className={`t-c1 ${tooLong ? "c-neg" : "c-alt"}`}>
            {count}/{MAX_REASON}
          </span>
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-out" type="button" onClick={() => void cancel()} disabled={busy}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void submit()} disabled={busy || tooLong}>
            {busy ? "푸는 중" : "제한 풀기"}
          </button>
        </div>
      </div>
    </section>
  );
}
