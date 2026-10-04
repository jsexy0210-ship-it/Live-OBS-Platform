"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { useLatestResponse } from "../../../../../components/seller/latestResponse";

// SA-043 구매 제한 중 「지금 주문이 막힌 구매자」 목록과 풀기(API: GET /api/seller/purchase-restrictions,
// POST …/{buyerMemberId}/lift, 회원·적립금 권한). 자동 제한 규칙은 주문 설정 화면에 있다. 직접 막기는 API가 생기면 붙인다.

type Restriction = { id: string; buyerMemberId: string; reason: string; startsAt: string; endsAt: string; buyerMember: { broadcastNickname: string | null } };

const REASON: Record<string, string> = {
  UNPAID_AUTO_CANCEL: "미입금 자동 취소 반복",
  PAID_CANCEL: "결제 후 취소 반복",
};

const DAY = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const MAX_REASON = 200;

// 한 구매자에게 사유가 다른 제한이 겹칠 수 있다(풀기는 구매자 단위로 모두 푼다): 구매자별로 묶어 가장 늦게 끝나는 날을 보인다
function byBuyer(rows: Restriction[]) {
  const map = new Map<string, { buyerMemberId: string; nickname: string | null; reasons: string[]; startsAt: string; endsAt: string }>();
  for (const r of rows) {
    const g = map.get(r.buyerMemberId);
    if (!g) {
      map.set(r.buyerMemberId, { buyerMemberId: r.buyerMemberId, nickname: r.buyerMember.broadcastNickname, reasons: [r.reason], startsAt: r.startsAt, endsAt: r.endsAt });
      continue;
    }
    if (!g.reasons.includes(r.reason)) g.reasons.push(r.reason);
    if (r.startsAt < g.startsAt) g.startsAt = r.startsAt;
    if (r.endsAt > g.endsAt) g.endsAt = r.endsAt;
  }
  return [...map.values()];
}
type Group = ReturnType<typeof byBuyer>[number];

export default function PurchaseRestrictionsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Restriction[] }>({ kind: "loading" });
  const [lifting, setLifting] = useState<Group | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const reads = useLatestResponse();

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ kind: "loading" });
      const t = reads.next();
      const r = await api<{ restrictions: Restriction[] }>("/api/seller/purchase-restrictions");
      if (!r.ok) {
        if (!reads.failMatters(t)) return false;
        if (!reads.hasApplied()) setState({ kind: "error", status: r.status });
        return false;
      }
      if (reads.accept(t) === "apply") {
        setState({ kind: "ok", rows: r.data.restrictions });
        setStale(false);
      }
      return true;
    },
    [reads],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const lifted = async (g: Group) => {
    setLifting(null);
    // 서버가 푼 구매자는 바로 목록에서 뺀다. 그 전에 보낸 다시 읽기 응답이 되살리지 않게 변경을 확정한다.
    reads.confirmChange();
    setState((s) => (s.kind === "ok" ? { kind: "ok", rows: s.rows.filter((r) => r.buyerMemberId !== g.buyerMemberId) } : s));
    const name = g.nickname ?? "구매자";
    if (await load(true)) setToast(`${name}의 구매 제한을 풀었습니다`);
    else {
      setStale(true);
      setToast(`${name}의 구매 제한을 풀었습니다 · 목록을 새로 불러오지 못했습니다`);
    }
  };

  const groups = state.kind === "ok" ? byBuyer(state.rows) : [];

  return (
    <>
      <Topbar crumb="판매 › 구매 제한" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">구매 제한</h1>
            <span className="t-l2 c-alt">
              지금 주문이 막힌 구매자입니다. 자동 제한 규칙은{" "}
              <Link href="/seller/settings/order" className="t-l2 fw6">
                주문 설정
              </Link>
              에서 정합니다.
            </span>
          </div>
        </div>

        {stale && (
          <div className="msg msg-cau" role="status" style={{ marginBottom: 16 }}>
            <span>목록이 최신이 아닐 수 있습니다.</span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => void load(true)}>
              다시 불러오기
            </button>
          </div>
        )}

        <section className="card col" aria-label="구매 제한 목록">
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : <ErrorState title="구매 제한 목록을 불러오지 못했습니다" onRetry={() => void load()} />)}
          {state.kind === "ok" &&
            (groups.length === 0 ? (
              <div className="st">
                <span className="t">주문이 막힌 구매자가 없습니다</span>
                <span className="s">자동 제한 규칙에 걸리면 이곳에 표시됩니다</span>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>구매자 · 사유 · 제한 기간</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.buyerMemberId} data-testid="restriction-row">
                        <td>
                          <div className="col" style={{ gap: 2 }}>
                            <span className="fw6">{g.nickname ?? <span className="c-alt">닉네임 없음</span>}</span>
                            <span className="t-c1">{g.reasons.map((r) => REASON[r] ?? "기타").join(" · ")}</span>
                            <span className="t-c1 c-alt num">
                              {DAY(g.startsAt)} ~ {DAY(g.endsAt)}
                            </span>
                          </div>
                        </td>
                        <td className="r" style={{ whiteSpace: "nowrap" }}>
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setLifting(g)}>
                            제한 풀기
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </section>
      </main>
      {lifting && <LiftModal group={lifting} onClose={() => setLifting(null)} onDone={() => void lifted(lifting)} onGone={() => void load(true).then(() => setLifting(null))} />}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

function LiftModal({ group, onClose, onDone, onGone }: { group: Group; onClose: () => void; onDone: () => void; onGone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = reason.length > MAX_REASON;

  const submit = async () => {
    if (tooLong) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/purchase-restrictions/${group.buyerMemberId}/lift`, { method: "POST", body: { reason: reason.trim() || undefined } });
    setBusy(false);
    if (r.ok) return onDone();
    // 404: 그사이 기간이 끝났거나 다른 사람이 이미 풀었다. 목록을 다시 읽어 맞춘다.
    if (r.status === 404) return onGone();
    setError(r.error === "invalid_reason" ? "사유에 쓸 수 없는 글자가 있습니다" : failMessage(r, "admin"));
  };

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="pr-lift-title">
      <div className="modal">
        <div className="modal-h">
          <h2 className="t-h2" id="pr-lift-title">
            구매 제한을 푸시겠습니까?
          </h2>
          <span className="t-l2 c-alt">{group.nickname ?? "이 구매자"}님이 바로 다시 주문할 수 있습니다. 자동 제한 횟수는 지금부터 새로 셉니다.</span>
        </div>
        <div className="col" style={{ gap: 6, padding: "0 24px" }}>
          <label className="lbl" htmlFor="pr-lift-reason">
            사유 (선택)
          </label>
          <textarea id="pr-lift-reason" className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 입금 확인 후 해제" />
          <span className={`t-c1 ${tooLong ? "c-neg" : "c-alt"}`}>
            {reason.length}/{MAX_REASON}
          </span>
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void submit()} disabled={busy || tooLong}>
            {busy ? "푸는 중" : "제한 풀기"}
          </button>
        </div>
      </div>
    </div>
  );
}
