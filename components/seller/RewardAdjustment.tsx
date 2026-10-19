"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../admin-ui";
import { confirmLeave, sanitizeNext, useSmartBack, useUnsavedGuard } from "../../lib/client/navigation";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission } from "./States";
import { api, failMessage } from "./api";
import { won } from "./format";

type AdjustmentMember = { member: { id: string; broadcastNickname: string | null }; balance: number };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; row: AdjustmentMember; live: boolean | null };
type PendingAdjustment = { id: string; intent: string };
type AdjustmentChoice = { key: string; intent: string; operations: PendingAdjustment[] };
const ADJUST_COPY = {
  rejectedCleanup: "거절된 요청의 보관 정보를 지우지 못했어요. 화면을 다시 불러와 주세요.",
  scope: "요청 정보를 확인하지 못했어요. 화면을 다시 불러와 주세요.",
  storage: "재시도 정보를 보관하지 못했어요. 원장에서 이전 조정 결과를 확인해 주세요.",
  cleanup: "조정은 완료됐지만 요청 정보를 정리하지 못했어요. 원장에서 결과를 확인해 주세요.",
  pending: "결과를 확인하지 못한 요청이 있어요. 원장을 확인한 뒤 이전 요청을 재시도하거나 새 조정을 선택해 주세요.",
  changed: "입력 내용이 바뀌었어요. 다시 적용해 주세요.",
  missing: "이전 요청 정보를 찾지 못했어요. 원장에서 결과를 확인해 주세요.",
  retryTitle: "이전 요청을 다시 보낼까요?",
  newTitle: "새 조정을 보낼까요?",
  newWarning: "이전 요청이 이미 반영됐다면 같은 금액이 한 번 더 조정될 수 있어요.",
};
const fingerprint = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, "0")).join("");
// 같은 탭의 현재 파트너스·사용자 범위에 UUID와 내용 지문만 보관한다. 금액·사유·닉네임은 저장하지 않는다.
function readAdjustments(key: string): PendingAdjustment[] {
  const value = sessionStorage.getItem(key);
  if (value === null) return [];
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && Object.keys(r).length === 2 && typeof r.id === "string" && typeof r.intent === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.id) && /^[0-9a-f]{64}$/.test(r.intent)) || new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error("invalid_pending_adjustment");
  return rows;
}
function writeAdjustments(key: string, rows: PendingAdjustment[]) {
  if (rows.length) {
    const value = JSON.stringify(rows);
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) throw new Error("pending_adjustment_not_saved");
  } else {
    sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== null) throw new Error("pending_adjustment_not_removed");
  }
}


export function RewardAdjustment({ memberId, returnTo }: { memberId: string; returnTo?: string | null }) {
  const { can, me } = useSeller();
  const canRead = can("MEMBER_POINTS");
  const canEdit = canRead && !me.readOnly;
  const safeReturnTo = sanitizeNext(returnTo, ["/seller/rewards/balances"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/rewards/balances" ? safeReturnTo : "/seller/rewards/balances";
  const back = useSmartBack(listHref);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [result, setResult] = useState("");
  const generation = useRef(0);
  const backHandler = useRef<(() => Promise<void>) | null>(null);
  const valid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(memberId);
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!canRead || !valid) return;
    setState({ kind: "loading" });
    const [member, live] = await Promise.all([
      api<{ member: { id: string; broadcastNickname: string | null; rewardBalance: number } }>(`/api/seller/members/${memberId}`),
      api<{ livePayout: { enabled: boolean } }>("/api/seller/reward-live-payout"),
    ]);
    if (request !== generation.current) return;
    if (!member.ok) return setState({ kind: "error", status: member.status });
    if (member.data.member.id.toLowerCase() !== memberId.toLowerCase()) return setState({ kind: "error", status: 404 });
    setState({ kind: "ok", row: { member: { id: member.data.member.id, broadcastNickname: member.data.member.broadcastNickname }, balance: member.data.member.rewardBalance }, live: live.ok ? live.data.livePayout.enabled : null });
  }, [canRead, valid, memberId]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  return <><Topbar crumb="고객 › 적립금 › 회원별 잔액 › 조정 상세" /><main className="main">
    <PageHead title="적립금 조정 상세" back={listHref} onBack={() => backHandler.current ? backHandler.current() : back()} />
    {result && <p className="msg msg-info" role="status">{result}</p>}
    {!canRead ? <NoPermission need="회원·적립금" /> : !valid ? <div className="card pad">회원을 목록에서 다시 선택해 주십시오.</div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={3} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="회원 정보를 불러오지 못했습니다" onRetry={() => void load()} /></div> : canEdit ? <AdjustmentForm key={memberId} backHandler={backHandler} row={state.row} live={state.live} scope={[me.sellerId, me.userId]} onClose={back} onDone={(text) => { setResult(text); void load(); }} /> : <section className="card pad" aria-label="회원 잔액"><h2 className="t-hl2">{state.row.member.broadcastNickname ?? "회원"}</h2><p>현재 잔액 {won(state.row.balance)}</p></section>}
  </main></>;
}

// 이전 요청 재시도와 새 조정은 구분한다. 닫기·화면 이동·새로고침은 미확정 UUID를 지우지 않는다.
function AdjustmentForm({ row, live, scope, onClose, onDone, backHandler }: { backHandler: { current: (() => Promise<void>) | null }; row: AdjustmentMember; live: boolean | null; scope: readonly [string, string]; onClose: () => void; onDone: (text: string) => void }) {
  const { confirm } = useConfirm();
  const [direction, setDirection] = useState<"GRANT" | "REVOKE">("GRANT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AdjustmentChoice | null>(null);
  const [retryId, setRetryId] = useState("");
  const nick = row.member.broadcastNickname ?? "회원";
  const amt = /^\d+$/.test(amount.replace(/,/g, "")) ? Number(amount.replace(/,/g, "")) : 0;
  const after = row.balance + (direction === "GRANT" ? amt : -amt);
  const dirty = amount !== "" || reason !== "";
  const releaseGuard = useUnsavedGuard(dirty);
  const requestClose = async () => {
    if (busy || !confirmLeave(dirty)) return;
    setBusy(true);
    await releaseGuard();
    onClose();
  };
  useEffect(() => { backHandler.current = requestClose; return () => { if (backHandler.current === requestClose) backHandler.current = null; }; });
  useEffect(() => { setPending(null); setRetryId(""); }, [row.member.id, direction, amount, reason, scope[0], scope[1]]);

  const requestContext = async (): Promise<AdjustmentChoice> => {
    if (!scope[0] || !scope[1]) throw new Error(ADJUST_COPY.scope);
    const key = `onq:reward-adjust:${await fingerprint(JSON.stringify(scope))}`;
    const intent = await fingerprint(JSON.stringify([row.member.id, direction, amt, reason.trim()]));
    return { key, intent, operations: readAdjustments(key).filter((r) => r.intent === intent) };
  };

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (amt < 1) return setError("금액은 1원 이상 입력해 주십시오");
    if (direction === "REVOKE" && amt > row.balance) return setError("회수할 금액이 회원 잔액보다 많습니다");
    if (!reason.trim()) return setError("사유를 입력해 주십시오");
    setError(null);
    setBusy(true);
    let context: AdjustmentChoice;
    try { context = await requestContext(); }
    catch (e) { setError(e instanceof Error && e.message === ADJUST_COPY.scope ? ADJUST_COPY.scope : ADJUST_COPY.storage); return; }
    finally { setBusy(false); }
    if (context.operations.length) {
      setPending(context);
      setRetryId(context.operations[0].id);
      return;
    }
    await send(context);
  };

  const send = async (context: AdjustmentChoice, previousId?: string, explicitNew = false) => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const current = await requestContext();
      if (current.key !== context.key || current.intent !== context.intent) { setPending(null); setError(ADJUST_COPY.changed); return; }
    } catch (e) { setError(e instanceof Error && e.message === ADJUST_COPY.scope ? ADJUST_COPY.scope : ADJUST_COPY.storage); return; }
    finally { setBusy(false); }
    const signedText = `${direction === "GRANT" ? "+" : "−"}${won(amt)}`;
    let result: { balanceAfter: number | null } | undefined;
    const ok = await confirm({
      title: explicitNew ? ADJUST_COPY.newTitle : previousId ? ADJUST_COPY.retryTitle : "적립금 잔액을 조정하시겠습니까?",
      body: <>{explicitNew && <p>{ADJUST_COPY.newWarning}</p>}{`${nick} · ${signedText} · 사유: ${reason.trim()} — ${live === false ? "실제 지급이 꺼져 있어 「대기」로 기록되고 잔액은 그대로입니다." : "조정하면 바로 회원 잔액에 반영되고 원장에 남습니다."}`}</>,
      confirmLabel: explicitNew ? "새 조정" : previousId ? "이전 요청 재시도" : "조정",
      run: async () => {
        setBusy(true);
        try {
          let operations: PendingAdjustment[];
          let requestId: string;
          try {
            operations = readAdjustments(context.key);
            if (previousId && !operations.some((r) => r.id === previousId && r.intent === context.intent)) return ADJUST_COPY.missing;
            if (!previousId && !explicitNew && operations.some((r) => r.intent === context.intent)) return ADJUST_COPY.pending;
            requestId = previousId ?? crypto.randomUUID();
            if (!previousId) operations.push({ id: requestId, intent: context.intent });
            // 동기 보관과 읽기 확인이 끝나야 금융 POST를 보낸다.
            writeAdjustments(context.key, operations);
          } catch { return ADJUST_COPY.storage; }
          const r = await api<{ balanceAfter: number | null }>(`/api/seller/reward-balances/${row.member.id}/adjust`, { method: "POST", body: { direction, amount: amt, reason: reason.trim(), requestId } });
          if (!r.ok) {
            // 이전 불명 요청과 모든 409는 보존한다. 이번에 새로 만든 ID의 명시적 무반영 거절만 정리한다.
            const rejectedNew = !previousId && ((r.status === 400 && r.error === "invalid_reward_adjust") || (r.status === 404 && r.error === "reward_adjust_member_not_found"));
            if (rejectedNew) {
              try { writeAdjustments(context.key, readAdjustments(context.key).filter((entry) => entry.id !== requestId)); }
              catch { return ADJUST_COPY.rejectedCleanup; }
            }
            return failMessage(r, "admin", "조정하지 못했습니다. 잠시 후 다시 시도해 주십시오");
          }
          try { writeAdjustments(context.key, readAdjustments(context.key).filter((entry) => entry.id !== requestId)); }
          catch { return ADJUST_COPY.cleanup; }
          result = r.data;
        } finally { setBusy(false); }
      },
    });
    if (!ok || !result) return;
    setBusy(true);
    await releaseGuard();
    onDone(
      result.balanceAfter === null
        ? `${nick} ${signedText} 대기로 기록 · 실제 지급을 켜면 반영됩니다`
        : `${nick} ${signedText} ${direction === "GRANT" ? "지급" : "회수"} · 잔액 ${won(result.balanceAfter)} · 원장에 기록`,
    );
  };

  return (
    <section className="card pad" aria-labelledby="adjust-title">
        <form onSubmit={apply} noValidate>
          <div>
            <h2 className="t-hl2" id="adjust-title">
              수동 조정 · {nick}
            </h2>
          </div>
          <div className="col" style={{ gap: 14, padding: "0 4px" }}>
            {error && (
              <div className="msg msg-neg" role="alert">
                <span>{error}</span>
              </div>
            )}
            {pending && (
              <div className="msg msg-info col" style={{ gap: 8 }} role="status">
                <span>{ADJUST_COPY.pending}</span>
                <Link className="lk" href="/seller/rewards/ledger" target="_blank" rel="noreferrer">원장 확인</Link>
                <label>이전 요청<select className="inp" aria-label="재시도할 이전 요청" value={retryId} onChange={(e) => setRetryId(e.target.value)}>
                  {pending.operations.map((op, index) => <option key={op.id} value={op.id}>이전 요청 {index + 1}</option>)}
                </select></label>
              </div>
            )}
            <div className="row between">
              <span className="t-l1">현재 잔액</span>
              <b data-testid="adjust-balance">{won(row.balance)}</b>
            </div>
            <div className="fld">
              <span className="lbl req">조정</span>
              <div className="row" style={{ gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                <label className="chk">
                  <input className="rdo" type="radio" name="adjust-dir" checked={direction === "GRANT"} onChange={() => setDirection("GRANT")} aria-label="지급" />
                  지급
                </label>
                <label className="chk">
                  <input className="rdo" type="radio" name="adjust-dir" checked={direction === "REVOKE"} onChange={() => setDirection("REVOKE")} aria-label="회수" />
                  회수
                </label>
                <input className="inp num" style={{ width: 140, textAlign: "right" }} inputMode="numeric" aria-label="조정 금액" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <span>원</span>
              </div>
            </div>
            <div className="fld">
              <label htmlFor="adjust-reason" className="req">
                사유
              </label>
              <input id="adjust-reason" className="inp" maxLength={200} placeholder="이벤트 보상" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <div className="row between">
              <span className="t-l1">조정 후 잔액</span>
              <span data-testid="adjust-after">
                <b>{won(Math.max(after, 0))}</b> · {live === false ? "실제 지급 꺼져 있어 대기로 기록" : "실제 지급 켜져 있어 즉시 반영 (꺼져 있으면 대기)"}
              </span>
            </div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 16 }}>
            <button className="btn btn-out" type="button" onClick={() => void requestClose()} disabled={busy}>
              취소
            </button>
            {pending ? <>
              <button className="btn btn-out" type="button" disabled={busy || !retryId} onClick={() => void send(pending, retryId)}>이전 요청 재시도</button>
              <button className="btn" type="button" disabled={busy} onClick={() => void send(pending, undefined, true)}>새 조정</button>
            </> : <button className="btn" type="submit" disabled={busy}>{busy ? "조정 중" : "적용"}</button>}
          </div>
        </form>
    </section>
  );
}
