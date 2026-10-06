"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, PageHead, SearchBox, SearchRow, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";

// SA-033 회원별 잔액(정본 SA-033 FINAL, 회원·적립금 권한). API: GET /api/seller/reward-balances(+export), POST …/{memberId}/adjust, GET reward-policy(등급 목록)·reward-live-payout(켜짐 여부).
// 검색(닉네임·이름)·등급·조건(잔액 있음/소멸 예정/지급 대기)·정렬은 주소가 기준이고 20명씩 「더 보기」. 「수동 조정」은 확인 창을 거쳐 한 건씩 지급·회수한다(사유 필수, 원장에 남음).
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

const PAGE = 20;
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
  const defaults = { q: "", field: "nickname", gradeId: "", condition: "", sort: "balance" };
  const [urlState, setUrlState] = useUrlState(defaults);
  const applied = useMemo<Cond>(
    () => ({ q: urlState.q, field: urlState.field === "name" ? "name" : "nickname", gradeId: urlState.gradeId, condition: urlState.condition, sort: urlState.sort }),
    [urlState.q, urlState.field, urlState.gradeId, urlState.condition, urlState.sort],
  );
  const [filter, setFilter] = useState<Cond>(applied);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
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
    setMore(false);
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

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await api<Res>(url(applied, state.next));
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ ...state, rows: [...state.rows, ...r.data.balances], next: r.data.nextCursor });
    else setToast("회원별 잔액을 더 불러오지 못했습니다. 다시 눌러 주십시오");
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
          <SearchRow label="검색어">
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
          <SearchRow label="등급">
            <select className="inp" aria-label="등급" value={filter.gradeId} onChange={(e) => setFilter({ ...filter, gradeId: e.target.value })}>
              <option value="">전체</option>
              {grades.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="조건">
            <select className="inp" aria-label="조건" value={filter.condition} onChange={(e) => setFilter({ ...filter, condition: e.target.value })}>
              <option value="">전체</option>
              {CONDITIONS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="정렬">
            <select className="inp" aria-label="정렬" value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value })}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
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
                {state.next && (
                  <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
                    <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                      {more ? "불러오는 중" : "더 보기"}
                    </button>
                  </div>
                )}
              </>
            ))}
        </div>
        <p className="help" style={{ marginTop: 16 }}>
          누적 값은 처리에 성공한 내역만 더한 것입니다. 탈퇴한 회원은 나오지 않습니다. 소멸 예정은 30일 안에 사라질 적립금입니다.
        </p>
      </main>
      {adjusting && (
        <AdjustModal
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

// 수동 조정 창: 지급/회수·금액·사유(필수) → 「조정」 → 확인 창 → POST. requestId는 확인 창을 열 때 만든다(응답을 잃고 다시 눌러도 한 번만 반영).
function AdjustModal({ row, live, onClose, onDone }: { row: Row; live: boolean | null; onClose: () => void; onDone: (text: string) => void }) {
  const { confirm } = useConfirm();
  const [direction, setDirection] = useState<"GRANT" | "REVOKE">("GRANT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nick = row.member.broadcastNickname ?? "회원";
  const amt = /^\d+$/.test(amount.replace(/,/g, "")) ? Number(amount.replace(/,/g, "")) : 0;
  const after = row.balance + (direction === "GRANT" ? amt : -amt);
  const dirty = amount !== "" || reason !== "";

  const apply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (amt < 1) return setError("금액은 1원 이상 입력해 주십시오");
    if (direction === "REVOKE" && amt > row.balance) return setError("회수할 금액이 회원 잔액보다 많습니다");
    if (!reason.trim()) return setError("사유를 입력해 주십시오");
    setError(null);
    const requestId = crypto.randomUUID();
    const signedText = `${direction === "GRANT" ? "+" : "−"}${won(amt)}`;
    let result: { balanceAfter: number | null } | undefined;
    const ok = await confirm({
      title: "적립금 잔액을 조정하시겠습니까?",
      body: `${nick} · ${signedText} · 사유: ${reason.trim()} — ${live === false ? "실제 지급이 꺼져 있어 「대기」로 기록되고 잔액은 그대로입니다." : "조정하면 바로 회원 잔액에 반영되고 원장에 남습니다."}`,
      confirmLabel: "조정",
      run: async () => {
        setBusy(true);
        const r = await api<{ balanceAfter: number | null }>(`/api/seller/reward-balances/${row.member.id}/adjust`, { method: "POST", body: { direction, amount: amt, reason: reason.trim(), requestId } });
        setBusy(false);
        if (!r.ok) return failMessage(r, "admin", "조정하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        result = r.data;
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
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "조정 중" : "적용"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
