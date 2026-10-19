"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { CursorPagination } from "../../../../../../components/Pagination";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
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
  const query = useSearchParams();
  const pathname = usePathname();
  const listHref = `${pathname}${query.size ? `?${query.toString()}` : ""}`;
  const defaults = { q: "", field: "nickname", gradeId: "", condition: "", sort: "balance" };
  const [urlState, setUrlState] = useUrlState(defaults);
  const applied = useMemo<Cond>(
    () => ({ q: urlState.q, field: urlState.field === "name" ? "name" : "nickname", gradeId: urlState.gradeId, condition: urlState.condition, sort: urlState.sort }),
    [urlState.q, urlState.field, urlState.gradeId, urlState.condition, urlState.sort],
  );
  const [filter, setFilter] = useState<Cond>(applied);
  const [state, setState] = useState<Load>({ kind: "loading" });
  // 같은 목록 기록으로 돌아올 때만 방문한 커서를 복원한다. 다른 사용자·조건·직접 진입은 첫 쪽이다.
  const [restored] = useState<{ page: number; cursors: (string | undefined)[] } | undefined>(() => {
    if (typeof window === "undefined") return;
    const saved = history.state?.rewardBalances;
    if (!saved || saved.scope !== JSON.stringify([me.sellerId, me.userId]) || saved.filters !== params(applied).toString() || !Number.isInteger(saved.page) || saved.page < 1 || !Array.isArray(saved.cursors) || saved.cursors.length !== saved.page || saved.cursors[0] !== null || !saved.cursors.slice(1).every((cursor: unknown) => typeof cursor === "string" && cursor.length > 0)) return;
    return { page: saved.page, cursors: saved.cursors.map((cursor: string | null) => cursor ?? undefined) };
  });
  const initialPaging = useRef(restored);
  const [page, setPage] = useState(restored?.page ?? 1);
  const [cursors, setCursors] = useState<(string | undefined)[]>(restored?.cursors ?? [undefined]);
  const paging = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [grades, setGrades] = useState<{ id: string; name: string }[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);

  const url = (c: Cond, cursor?: string) => {
    const p = params(c);
    p.set("limit", String(PAGE));
    if (cursor) p.set("cursor", cursor);
    return `/api/seller/reward-balances?${p.toString()}`;
  };
  type Res = { balances: Row[]; summary: Summary; pending: { count: number; amount: number }; nextCursor: string | null };
  const load = useCallback(async (c: Cond, restore?: { page: number; cursors: (string | undefined)[] }) => {
    const id = ++reqId.current;
    paging.current = false; setPage(restore?.page ?? 1); setCursors(restore?.cursors ?? [undefined]);

    setState({ kind: "loading" });
    const r = await api<Res>(url(c, restore?.cursors[restore.page - 1]));
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", rows: r.data.balances, next: r.data.nextCursor, summary: r.data.summary, pending: r.data.pending } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => { const restore = initialPaging.current; initialPaging.current = undefined; void load(applied, restore); }, [applied, load]);
  useEffect(() => {
    if (state.kind !== "ok") return;
    history.replaceState({ ...history.state, rewardBalances: { scope: JSON.stringify([me.sellerId, me.userId]), filters: params(applied).toString(), page, cursors: cursors.map((cursor) => cursor ?? null) } }, "", location.href);
  }, [state.kind, me.sellerId, me.userId, applied, page, cursors]);
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
                            <Link className="btn btn-sm btn-out" href={`/seller/rewards/balances/${r.member.id}?${new URLSearchParams({ returnTo: listHref })}`} aria-label={`${r.member.broadcastNickname ?? "회원"} 적립금 조정`}>
                              조정 상세
                            </Link>
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
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
