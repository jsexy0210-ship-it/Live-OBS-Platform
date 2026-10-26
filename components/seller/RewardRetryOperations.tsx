"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../admin-ui";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "./States";
import { api, failMessage } from "./api";
import { won } from "./format";
import { formatDateTime } from "../../lib/client/format";
import { sanitizeNext, useSmartBack } from "../../lib/client/navigation";

export type Status = "PENDING" | "SUCCEEDED" | "FAILED";
export type Kind = "EARN_DELIVERY" | "EARN_PAYMENT" | "REVIEW" | "REVOKE" | "ADJUST_GRANT" | "ADJUST_REVOKE" | "BONUS" | "USE" | "EXPIRE";
export type Entry = {
  id: string;
  member: { id: string; broadcastNickname: string | null };
  kind: Kind;
  amount: number;
  status: Status;
  failureReason: string | null;
  reason: string | null;
  balanceAfter: number | null;
  order: { id: string; orderNo: number; orderNoLabel: string; createdAt: string; firstProductName: string | null; itemCount: number } | null;
  testMode: boolean;
  createdAt: string;
};
type Sum = { count: number; amount: number };
export type Summary = { pending: Sum; todaySucceeded: Sum; failed: Sum; todayRevoked: Sum; issuedBalance: number };
export const KIND: Record<Kind, string> = {
  EARN_DELIVERY: "배송 완료 적립",
  EARN_PAYMENT: "결제 적립",
  REVIEW: "리뷰 적립",
  REVOKE: "회수",
  ADJUST_GRANT: "수동 지급",
  ADJUST_REVOKE: "수동 회수",
  BONUS: "인기 카드 보너스",
  USE: "사용",
  EXPIRE: "소멸",
};
export const STATUS: Record<Status, { label: string; cls: string }> = {
  PENDING: { label: "대기", cls: "b-warn" },
  SUCCEEDED: { label: "성공", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
};

const n = (v: number) => v.toLocaleString("ko-KR");
const signed = (n: number) => (n > 0 ? `+${won(n)}` : n < 0 ? `−${won(Math.abs(n))}` : won(0));
export function RewardRetryOperations({ entryId, returnTo }: { entryId?: string; returnTo: string | null }) {
  const { can, me } = useSeller();
  const canEdit = can("MEMBER_POINTS") && !me.readOnly;
  const safe = sanitizeNext(returnTo, ["/seller/rewards/ledger"]);
  const listHref = safe?.split("?")[0] === "/seller/rewards/ledger" ? safe : "/seller/rewards/ledger";
  const back = useSmartBack(listHref);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; entry: Entry | null }>({ kind: "loading" });
  const [live, setLive] = useState<boolean | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { confirm } = useConfirm();
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setState({ kind: "loading" }); setLive(null); setFailedCount(0);
    if (entryId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryId)) return setState({ kind: "error", status: 404 });
    const [data, policy] = await Promise.all([
      entryId ? api<{ entry: Entry }>(`/api/seller/reward-ledger/${entryId}`) : api<{ summary: Summary }>("/api/seller/reward-ledger/summary"),
      api<{ livePayout: { enabled: boolean } }>("/api/seller/reward-live-payout"),
    ]);
    if (request !== generation.current) return;
    if (!data.ok || !policy.ok) return setState({ kind: "error", status: !data.ok ? data.status : policy.status });
    setLive(policy.data.livePayout.enabled);
    if (entryId) {
      if (!("entry" in data.data) || data.data.entry.id.toLowerCase() !== entryId?.toLowerCase()) return setState({ kind: "error", status: 404 });
      setState({ kind: "ok", entry: data.data.entry });
    } else if ("summary" in data.data) { setFailedCount(data.data.summary.failed.count); setState({ kind: "ok", entry: null }); }
    else setState({ kind: "error", status: 500 });
  }, [entryId]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const retry = async (ids?: string[]) => {
    if (!canEdit || busy || state.kind !== "ok" || live !== true || (entryId ? state.entry?.status !== "FAILED" : failedCount === 0)) return;
    const count = ids ? ids.length : failedCount;
    let message = "";
    const ok = await confirm({
      title: ids ? "실패한 지급을 다시 시도하시겠습니까?" : `실패 ${n(count)}건을 다시 시도하시겠습니까?`,
      body: "잔액이 모자라 실패한 회수는 다시 실패로 남을 수 있습니다. 성공한 줄은 바뀌지 않습니다.",
      confirmLabel: "다시 시도",
      run: async () => {
        setBusy(true);
        const r = await api<{ requested: number; result: { settled: number; failed: number; skipped: "not_live" | null } }>("/api/seller/reward-ledger/retry", { method: "POST", body: ids ? { ids } : {} });
        setBusy(false);
        if (!r.ok) return failMessage(r, "admin", "다시 시도하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        const { settled, failed, skipped } = r.data.result;
        message = skipped === "not_live" ? "실제 지급이 꺼져 있어 바뀐 것이 없습니다" : `실패 ${n(settled + failed)}건 중 ${n(settled)}건 성공${failed > 0 ? ` · ${n(failed)}건 다시 실패` : ""}`;
      },
    });
    if (!ok) return;
    setToast(message);
    await load();
  };

  const entry = state.kind === "ok" ? state.entry : null;
  return <><Topbar crumb="고객 › 적립금 › 지급 · 회수 원장 › 재시도" /><main className="main">
    <PageHead title="지급 재시도" back={listHref} onBack={() => { if (!busy) back(); }} />
    {state.kind === "loading" ? <LoadingRows rows={3} /> : state.kind === "error" ? state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title={state.status === 404 ? "적립 내역을 찾을 수 없습니다" : "적립 내역을 불러오지 못했습니다"} onRetry={() => void load()} /> : <section className="card pad" aria-label="지급 재시도 대상">
      {entry ? <dl><dt>회원</dt><dd>{entry.member.broadcastNickname ?? "닉네임 없음"}</dd><dt>일시</dt><dd>{formatDateTime(entry.createdAt)}</dd><dt>유형</dt><dd>{KIND[entry.kind]}{entry.testMode ? " · 계산만" : ""}</dd><dt>금액</dt><dd>{signed(entry.amount)}</dd><dt>잔액(후)</dt><dd>{entry.balanceAfter === null ? "—" : won(entry.balanceAfter)}</dd><dt>상태</dt><dd>{STATUS[entry.status].label}</dd><dt>실패 사유</dt><dd>{entry.failureReason ?? "—"}</dd></dl> : <p>전체 쇼핑몰의 실패 {n(failedCount)}건이 대상입니다. 한 번에 최대 200건을 처리합니다.</p>}
      {live === false && <p role="status">실제 지급이 꺼져 있어 재시도할 수 없습니다.</p>}
      {!canEdit && <p role="status">읽기 전용입니다.</p>}
      <button className="btn btn-out" type="button" disabled={busy} onClick={back}>목록으로</button>
      {canEdit && <button className="btn" type="button" disabled={busy || live !== true || (entry ? entry.status !== "FAILED" : failedCount === 0)} onClick={() => void retry(entryId ? [entryId] : undefined)}>{entryId ? "실패한 지급 재시도" : failedCount ? `실패 ${n(failedCount)}건 재시도` : "재시도할 실패 없음"}</button>}
    </section>}
  </main>{toast && <Toast text={toast} onDone={() => setToast(null)} />}</>;
}
