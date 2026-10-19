"use client";

import Link from "next/link";
import { CursorPagination } from "../../../../../../components/Pagination";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, PageHead, SearchBox, SearchRow, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";

// SA-033 회원별 잔액(정본 SA-033 FINAL, 회원·적립금 권한). API: GET /api/seller/reward-balances(+export), POST …/{memberId}/adjust, GET reward-policy(등급 목록)·reward-live-payout(켜짐 여부).
// 검색(닉네임·이름)·등급·조건(잔액 있음/소멸 예정/지급 대기)·정렬은 주소가 기준이고 10명씩 현재 쪽을 조회합니다. 「수동 조정」은 확인 창을 거쳐 한 건씩 지급·회수한다(사유 필수, 원장에 남음).
type Row = {
  member: { id: string; broadcastNickname: string | null };
  grade: { id: string; name: string } | null;
  balance: number;
  totalEarned: number;
  totalUsed: number;
  expiry: { amount: number; expiresAt: string; soon: boolean } | null;
  pendingCount: number;
  updatedAt: string | null;
};
type Summary = { count: number; totalBalance: number };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; next: string | null; summary: Summary; pending: { count: number; amount: number } };

const PAGE = 10;
const SORTS = [
  { key: "balance", label: "잔액 많은 순" },
  { key: "expiring", label: "소멸 예정 가까운 순" },
  { key: "recent", label: "최근 변동순" },
] as const;
const CONDITIONS = [
  { key: "hasBalance", label: "잔액 있음" },
  { key: "expiring", label: "소멸 예정 있음" },
  { key: "pending", label: "지급 대기 있음" },
] as const;
const n = (v: number) => v.toLocaleString("ko-KR");
const md = (iso: string) => {
  const [, m, d] = formatDate(iso).split(".");
  return m ? `${Number(m)}/${Number(d)}` : "";
};

type Cond = { q: string; field: "nickname" | "name"; gradeId: string; condition: string; sort: string };
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

function params(c: Cond) {
  const p = new URLSearchParams();
  if (c.q) {
    p.set("q", c.q);
    p.set("field", c.field);
  }
  if (c.gradeId) p.set("gradeId", c.gradeId);
  if (c.condition) p.set("condition", c.condition);
  if (c.sort) p.set("sort", c.sort);
  return p;
}

export default function RewardBalancesPage() {
  const { me } = useSeller();
  const defaults = { q: "", field: "nickname", gradeId: "", condition: "", sort: "balance" };
  const [urlState, setUrlState] = useUrlState(defaults);
  const applied = useMemo<Cond>(
    () => ({ q: urlState.q, field: urlState.field === "name" ? "name" : "nickname", gradeId: urlState.gradeId, condition: urlState.condition, sort: urlState.sort }),
    [urlState.q, urlState.field, urlState.gradeId, urlState.condition, urlState.sort],
  );
  const [filter, setFilter] = useState<Cond>(applied);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [grades, setGrades] = useState<{ id: string; name: string }[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);

  const url = (c: Cond, cursor?: string) => {
    const p = params(c);
    p.set("limit", String(PAGE));
    if (cursor) p.set("cursor", cursor);
    return `/api/seller/reward-balances?${p.toString()}`;
  };
  type Res = { balances: Row[]; summary: Summary; pending: { count: number; amount: number }; nextCursor: string | null };
  const load = useCallback(async (c: Cond) => {
    const id = ++reqId.current;
    paging.current = false; setPage(1); setCursors([undefined]);

    setState({ kind: "loading" });
    const r = await api<Res>(url(c));
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", rows: r.data.balances, next: r.data.nextCursor, summary: r.data.summary, pending: r.data.pending } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  useEffect(() => setFilter(applied), [applied]);
  useScrollRestore("seller-reward-balances", state.kind === "ok");
  useEffect(() => {
    void (async () => {
      const [g, l] = await Promise.all([api<{ policy: { grades: { id: string; name: string }[] } }>("/api/seller/reward-policy"), api<{ livePayout: { enabled: boolean } }>("/api/seller/reward-live-payout")]);
      if (g.ok) setGrades(g.data.policy.grades);
      if (l.ok) setLive(l.data.livePayout.enabled);
    })();
  }, []);

  const goPage = async (target: number, cursor = cursors[target - 1]) => {
    if (state.kind !== "ok" || paging.current || target < 1 || target > cursors.length + 1) return;
    paging.current = true;
    const id = reqId.current;
    const r = await api<Res>(url(applied, cursor));
    if (id !== reqId.current) return;
    paging.current = false;
    if (r.ok) {
      setState({ kind: "ok", rows: r.data.balances, next: r.data.nextCursor, summary: r.data.summary, pending: r.data.pending });
      setCursors((prev) => [...prev.slice(0, target - 1), cursor]); setPage(target);

    } else setToast("목록을 불러오지 못했습니다. 다시 눌러 주십시오");
  };

  const rows = state.kind === "ok" ? state.rows : [];
  const search = () => setUrlState({ q: filter.q.trim(), field: filter.field, gradeId: filter.gradeId, condition: filter.condition, sort: filter.sort });
  const filtered = !!(applied.q || applied.gradeId || applied.condition);
  const exportHref = `/api/seller/reward-balances/export?${params(applied).toString()}`;

  return (
    <>
      <Topbar crumb="고객 › 적립금 › 회원별 잔액" />
      <main className="main">
        <PageHead title="회원별 잔액" />

        <SearchBox
          onSearch={search}
          onReset={() => {
            setFilter({ ...defaults, field: "nickname" });
            setUrlState(defaults);
          }}
        >
          <SearchRow
            label="검색어"
            label2="등급"
            children2={
              <select className="inp" aria-label="등급" value={filter.gradeId} onChange={(e) => setFilter({ ...filter, gradeId: e.target.value })}>
                <option value="">전체</option>
                {grades.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            }
          >
            <div className="row" style={{ gap: 8 }}>
              <select className="inp" style={{ width: 110, flex: "none" }} aria-label="검색 대상" value={filter.field} onChange={(e) => setFilter({ ...filter, field: e.target.value as Cond["field"] })}>
                <option value="nickname">닉네임</option>
                <option value="name">이름</option>
              </select>
              <input
                className="inp"
                style={{ minWidth: 0 }}
                type="text"
                aria-label="검색어"
                maxLength={50}
                value={filter.q}
                onChange={(e) => setFilter({ ...filter, q: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") search();
                }}
              />
            </div>
          </SearchRow>
          <SearchRow
            label="조건"
            label2="정렬"
            children2={
              <select className="inp" aria-label="정렬" value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value })}>
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            }
          >
            <select className="inp" aria-label="조건" value={filter.condition} onChange={(e) => setFilter({ ...filter, condition: e.target.value })}>
              <option value="">전체</option>
              {CONDITIONS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </SearchRow>
        </SearchBox>

        {state.kind === "ok" && live === false && state.pending.count > 0 && (
          <div className="msg msg-info" role="note" data-testid="balances-pending" style={{ marginTop: 16 }}>
            <span>실제 지급을 켜면 대기 중 {n(state.pending.count)}건이 반영됩니다.</span>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="회원별 잔액을 불러오지 못했습니다" onRetry={() => void load(applied)} />)}
          {state.kind === "ok" &&
            (rows.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? (applied.q ? `「${applied.q}」 결과가 없습니다` : "조건에 맞는 회원이 없습니다") : "잔액이 있는 회원이 없습니다"}</span>
                {!filtered && state.pending.count > 0 && <span className="s">실제 지급을 켜면 대기 중 {n(state.pending.count)}건이 반영됩니다.</span>}
              </div>
            ) : (
              <>
                <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span className="t-l2" data-testid="balances-summary">
                    <b>{n(state.summary.count)}</b>명 · 합계 잔액 <b>{won(state.summary.totalBalance)}</b>
                  </span>
                  <a className="btn btn-sm btn-out" href={exportHref} download>
                    엑셀 내려받기
                  </a>
                </div>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table className="tbl tbl-card" data-testid="balance-table">
                    <thead>
                      <tr>
                        <th>회원</th>
                        <th>등급</th>
                        <th>잔액</th>
                        <th>누적 지급</th>
                        <th>누적 사용</th>
                        <th>소멸 예정</th>
                        <th>마지막 변동</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.member.id} data-testid="balance-row">
                          <td className="col-text" data-card="title">
                            <Link href={`/seller/members/${r.member.id}`}>{r.member.broadcastNickname ?? "닉네임 없음"}</Link>
                          </td>
                          <td data-card="field">{r.grade?.name ?? "-"}</td>
                          <td>
                            <b>{won(r.balance)}</b>
                          </td>
                          <td>{won(r.totalEarned)}</td>
                          <td>{won(r.totalUsed)}</td>
                          <td>{r.expiry?.soon ? `${won(r.expiry.amount)} · ${md(r.expiry.expiresAt)}` : "—"}</td>
                          <td className="num" data-label-set data-label="변동">{r.updatedAt ? formatDateTime(r.updatedAt) : "—"}</td>
                          <td data-card="actions">
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setAdjusting(r)} aria-label={`${r.member.broadcastNickname ?? "회원"} 적립금 조정`}>
                              조정
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

              </>
            ))}
          {state.kind === "ok" && (page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={(target) => void goPage(target)} onNext={() => { if (state.next) void goPage(page + 1, state.next); }} />}
        </div>
        <p className="help" style={{ marginTop: 16 }}>
          누적 값은 처리에 성공한 내역만 더한 것입니다. 탈퇴한 회원은 나오지 않습니다. 소멸 예정은 30일 안에 사라질 적립금입니다.
        </p>
      </main>
      {adjusting && (
        <AdjustModal
          scope={[me.sellerId, me.userId]}
          row={adjusting}
          live={live}
          onClose={() => setAdjusting(null)}
          onDone={(text) => {
            setAdjusting(null);
            setToast(text);
            void load(applied);
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

// 이전 요청 재시도와 새 조정은 구분한다. 닫기·화면 이동·새로고침은 미확정 UUID를 지우지 않는다.
function AdjustModal({ row, live, scope, onClose, onDone }: { row: Row; live: boolean | null; scope: readonly [string, string]; onClose: () => void; onDone: (text: string) => void }) {
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
    onDone(
      result.balanceAfter === null
        ? `${nick} ${signedText} 대기로 기록 · 실제 지급을 켜면 반영됩니다`
        : `${nick} ${signedText} ${direction === "GRANT" ? "지급" : "회수"} · 잔액 ${won(result.balanceAfter)} · 원장에 기록`,
    );
  };

  return (
    <Modal labelId="adjust-title" busy={busy} dirty={dirty} onClose={onClose}>
      {(requestClose) => (
        <form onSubmit={apply} noValidate>
          <div className="modal-h">
            <h2 className="modal-t" id="adjust-title">
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
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            {pending ? <>
              <button className="btn btn-out" type="button" disabled={busy || !retryId} onClick={() => void send(pending, retryId)}>이전 요청 재시도</button>
              <button className="btn" type="button" disabled={busy} onClick={() => void send(pending, undefined, true)}>새 조정</button>
            </> : <button className="btn" type="submit" disabled={busy}>{busy ? "조정 중" : "적용"}</button>}
          </div>
        </form>
      )}
    </Modal>
  );
}
