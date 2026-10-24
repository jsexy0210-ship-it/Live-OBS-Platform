"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { type Entry, type Status, type Kind, type Summary, KIND, STATUS } from "../../../../../../components/seller/RewardRetryOperations";
import { CursorPagination } from "../../../../../../components/Pagination";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateRangePicker, ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { useScrollRestore, useUrlState } from "../../../../../../lib/client/navigation";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { effectiveRange, listDefaults } from "../../../../../../lib/client/filterDefaults";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";

// SA-032 적립금 지급·회수 원장(정본 SA-032 FINAL). 회원·적립금 권한. API: GET /api/seller/reward-ledger(+summary·export·retry), GET /api/seller/reward-live-payout.
// 기간(기본 최근 1개월)·상태·유형·검색어는 주소가 기준이고, 10건씩 현재 쪽을 조회합니다. 요약 카드는 쇼핑몰 전체 기준(기간과 무관).
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; entries: Entry[]; next: string | null };
const PAGE = 10;
const KIND_FILTER: Kind[] = ["EARN_DELIVERY", "EARN_PAYMENT", "REVOKE", "ADJUST_GRANT", "ADJUST_REVOKE", "REVIEW", "BONUS"];
// 상태 칩 「회수」는 서버에서는 유형 REVOKE로 보낸다
type StatusChoice = Status | "REVOKE" | "";
const signed = (n: number) => (n > 0 ? `+${won(n)}` : n < 0 ? `−${won(Math.abs(n))}` : won(0));
const n = (v: number) => v.toLocaleString("ko-KR");
const md = (iso: string) => {
  const [, m, d] = formatDate(iso).split(".");
  return m ? `${Number(m)}/${Number(d)}` : "";
};

type Cond = { from: string; to: string; status: StatusChoice; kind: Kind | ""; q: string };

function params(c: Cond) {
  const p = new URLSearchParams({ from: c.from, to: c.to });
  if (c.status === "REVOKE") p.set("kind", "REVOKE");
  else {
    if (c.status) p.set("status", c.status);
    if (c.kind) p.set("kind", c.kind);
  }
  if (c.q.trim()) p.set("q", c.q.trim());
  return p;
}

// 「사유 · 주문」: 주문이 있으면 「10/1 주문 · 첫 상품 외 N」(회수는 「환불」), 수동 조정·실패 사유는 뒤에 붙인다
function reasonText(e: Entry): string {
  const parts: string[] = [];
  if (e.order) {
    const first = e.order.firstProductName ? `${e.order.firstProductName}${e.order.itemCount > 1 ? ` 외 ${e.order.itemCount - 1}` : ""}` : "";
    parts.push([`${md(e.order.createdAt)} ${e.kind === "REVOKE" ? "환불" : "주문"}`, first].filter(Boolean).join(" · "));
  }
  const extra = e.reason ?? e.failureReason;
  if (extra) parts.push(extra);
  return parts.join(" · ") || "-";
}

export default function RewardLedgerPage() {
  const { can, me } = useSeller();
  const canEdit = can("MEMBER_POINTS") && !me.readOnly;
  const queryState = useSearchParams(), pathname = usePathname(), router = useRouter();
  const listHref = `${pathname}${queryState.size ? `?${queryState.toString()}` : ""}`;
  const detailHref = (entryId?: string) => `/seller/rewards/ledger/${entryId ?? "retry"}?${new URLSearchParams({ returnTo: listHref })}`;
  // 조건은 주소(?from=&to=&status=&kind=&q=)가 기준이다(Back 규칙). 기본은 최근 1개월, period=all은 기간 제한 없이
  const defaults = listDefaults({ status: "", kind: "", q: "" });
  const [urlState, setUrlState] = useUrlState({ from: defaults.from, to: defaults.to, period: "", status: "", kind: "", q: "" });
  const appliedStatus: StatusChoice = urlState.status in STATUS || urlState.status === "REVOKE" ? (urlState.status as StatusChoice) : "";
  const appliedKind: Kind | "" = urlState.kind in KIND ? (urlState.kind as Kind) : "";
  const applied = useMemo<Cond>(
    () => ({ ...effectiveRange({ from: urlState.from, to: urlState.to, period: urlState.period }), status: appliedStatus, kind: appliedKind, q: urlState.q }),
    [urlState.from, urlState.to, urlState.period, appliedStatus, appliedKind, urlState.q],
  );
  const [filter, setFilter] = useState<Cond>(applied);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [summary, setSummary] = useState<Summary | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const initialPaging = useRef(true);
  const pagingScope = useRef("");

  const url = (cond: Cond, cursor?: string) => {
    const p = params(cond);
    p.set("limit", String(PAGE));
    if (cursor) p.set("cursor", cursor);
    return `/api/seller/reward-ledger?${p.toString()}`;
  };
  const load = useCallback(async (cond: Cond) => {
    const id = ++reqId.current;
    paging.current = false;
    let scope = "";
    try { if (me.sellerId && me.userId) scope = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([me.sellerId, me.userId, params(cond).toString()])))), n => n.toString(16).padStart(2, "0")).join(""); } catch {}
    if (id !== reqId.current) return;
    pagingScope.current = scope;
    let restore: { page: number; cursors: (string | undefined)[] } | undefined;
    if (initialPaging.current && scope) {
      try { const stored = sessionStorage.getItem("onq:reward-ledger:return"); sessionStorage.removeItem("onq:reward-ledger:return"); const saved = JSON.parse(stored ?? "null"); if (saved?.scope === scope && Number.isInteger(saved.page) && saved.page >= 1 && Array.isArray(saved.cursors) && saved.cursors.length === saved.page && saved.cursors[0] === null && saved.cursors.slice(1).every((c: unknown) => typeof c === "string" && c.length > 0)) { restore = { page: saved.page, cursors: saved.cursors.map((c: string | null) => c ?? undefined) }; } } catch {}
    }
    initialPaging.current = false;
    setPage(restore?.page ?? 1); setCursors(restore?.cursors ?? [undefined]);

    setState({ kind: "loading" });
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(url(cond, restore?.cursors[restore.page - 1]));
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", entries: r.data.entries, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, [me.sellerId, me.userId]);
  const loadSummary = useCallback(async () => {
    const [s, l] = await Promise.all([api<{ summary: Summary }>("/api/seller/reward-ledger/summary"), api<{ livePayout: { enabled: boolean } }>("/api/seller/reward-live-payout")]);
    if (s.ok) setSummary(s.data.summary);
    if (l.ok) setLive(l.data.livePayout.enabled);
  }, []);
  useEffect(() => { void load(applied); return () => { reqId.current++; }; }, [applied, load]);
  useEffect(() => void loadSummary(), [loadSummary]);
  // 주소가 바뀌면(뒤로 가기 등) 입력 칸도 같은 값으로
  useEffect(() => setFilter(applied), [applied]);
  useScrollRestore("seller-reward-ledger", state.kind === "ok");

  const goPage = async (target: number, cursor = cursors[target - 1]) => {
    if (state.kind !== "ok" || paging.current || target < 1 || target > cursors.length + 1) return;
    paging.current = true;
    const id = reqId.current;
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(url(applied, cursor));
    if (id !== reqId.current) return;
    paging.current = false;
    if (r.ok) {
      setState({ kind: "ok", entries: r.data.entries, next: r.data.nextCursor });
      setCursors((prev) => [...prev.slice(0, target - 1), cursor]); setPage(target);

    } else setToast("목록을 불러오지 못했습니다. 다시 눌러 주십시오");
  };


  const rememberPage = async (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try { if (pagingScope.current) sessionStorage.setItem("onq:reward-ledger:return", JSON.stringify({ scope: pagingScope.current, page, cursors })); } catch {}
    router.push(href);
  };
  const entries = state.kind === "ok" ? state.entries : [];
  const exportHref = `/api/seller/reward-ledger/export?${params(applied).toString()}`;
  const failedCount = summary?.failed.count ?? 0;
  const cards: [string, string, string][] = summary
    ? [
        ["대기 (지급 예정)", `${n(summary.pending.count)}건 · ${won(summary.pending.amount)}`, "sum-pending"],
        ["오늘 성공", `${n(summary.todaySucceeded.count)}건 · ${won(summary.todaySucceeded.amount)}`, "sum-ok"],
        ["실패", `${n(summary.failed.count)}건 · ${won(summary.failed.amount)}`, "sum-failed"],
        ["오늘 회수", `${n(summary.todayRevoked.count)}건 · ${won(summary.todayRevoked.amount)}`, "sum-revoked"],
        ["총 발행 잔액", won(summary.issuedBalance), "sum-balance"],
      ]
    : [];

  return (
    <>
      <Topbar crumb="고객 › 적립금 › 지급 · 회수 원장" />
      <main className="main">
        <PageHead title="지급 · 회수 원장" />

        {live === false && (
          <div className="msg msg-cau row between" role="note" data-testid="ledger-live-off" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            <span>실제 지급 꺼짐. 모든 지급은 「대기」로만 기록되고 잔액에 반영되지 않습니다. 켜는 순간 대기분이 일괄 지급됩니다.</span>
            <Link className="btn btn-sm btn-out" href="/seller/rewards/live-payout">
              실제 지급 켜기
            </Link>
          </div>
        )}

        {cards.length > 0 && (
          <div className="stat-row" data-testid="ledger-summary" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
            {cards.map(([label, value, id]) => (
              <div key={id} className="card pad col" style={{ gap: 4 }}>
                <span className="t-l2 c-alt">{label}</span>
                <span className="t-h2" data-testid={id}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        )}

        <SearchBox
          onSearch={() => setUrlState({ from: filter.from, to: filter.to, period: "", status: filter.status, kind: filter.kind, q: filter.q.trim() })}
          onReset={() => {
            setFilter({ from: defaults.from, to: defaults.to, status: "", kind: "", q: "" });
            setUrlState({ from: defaults.from, to: defaults.to, period: "", status: "", kind: "", q: "" });
          }}
        >
          <SearchRow label="기간">
            <DateRangePicker quick fromLabel="시작일" toLabel="종료일" from={filter.from} to={filter.to} onChange={(r) => setFilter({ ...filter, ...r })} />
          </SearchRow>
          <SearchRow label="상태">
            <select className="inp" aria-label="상태" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value as StatusChoice })}>
              <option value="">전체</option>
              <option value="PENDING">대기</option>
              <option value="SUCCEEDED">성공</option>
              <option value="FAILED">실패</option>
              <option value="REVOKE">회수</option>
            </select>
          </SearchRow>
          <SearchRow label="유형">
            <select className="inp" aria-label="유형" value={filter.kind} disabled={filter.status === "REVOKE"} onChange={(e) => setFilter({ ...filter, kind: e.target.value as Kind | "" })}>
              <option value="">전체</option>
              {KIND_FILTER.map((k) => (
                <option key={k} value={k}>
                  {KIND[k]}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="검색어">
            <input className="inp" aria-label="검색어" placeholder="회원 닉네임 또는 주문번호" maxLength={50} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          </SearchRow>
        </SearchBox>

        <div className="row between" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
          <span className="t-c1 c-alt">엑셀은 지금 조건으로 최대 5,000건까지 받습니다</span>
          <div className="row" style={{ gap: 8 }}>
            {canEdit && (failedCount === 0 || live !== true ? <button className="btn btn-sm btn-out" type="button" disabled>{failedCount > 0 ? `실패 ${n(failedCount)}건 재시도` : "재시도할 실패 없음"}</button> : <Link className="btn btn-sm btn-out" href={detailHref()} onClick={e => void rememberPage(e, detailHref())}>실패 {n(failedCount)}건 재시도</Link>)}
            <a className="btn btn-sm btn-out" href={exportHref} download>
              엑셀 내려받기
            </a>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="적립금 내역을 불러오지 못했습니다" onRetry={() => void load(applied)} />)}
          {state.kind === "ok" &&
            (entries.length === 0 ? (
              <div className="st">
                <span className="t">{applied.status || applied.kind || applied.q || applied.from !== defaults.from || applied.to !== defaults.to ? "조건에 맞는 내역이 없습니다" : "아직 적립 기록이 없습니다"}</span>
                {!applied.status && !applied.kind && !applied.q && applied.from === defaults.from && applied.to === defaults.to && <span className="s">주문이 결제되면 지급 대기로 쌓입니다</span>}
              </div>
            ) : (
              <>
                <ListHead total={entries.length} loaded />
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl tbl-card" data-testid="ledger-table">
                    <thead>
                      <tr>
                        <th>회원</th>
                        <th>일시</th>
                        <th>유형</th>
                        <th>사유 · 주문</th>
                        <th>금액</th>
                        <th>잔액(후)</th>
                        <th>상태</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id} data-testid="ledger-row">
                          <td className="col-text" data-card="title">
                            <Link href={`/seller/members/${e.member.id}`}>{e.member.broadcastNickname ?? "닉네임 없음"}</Link>
                          </td>
                          <td className="num">{formatDateTime(e.createdAt)}</td>
                          <td>
                            {KIND[e.kind]}
                            {e.status === "PENDING" ? " (대기)" : ""}
                            {e.testMode ? " · 계산만" : ""}
                          </td>
                          <td className="col-text" data-card="wide" data-label-set data-label="사유">
                            {e.order ? <Link href={`/seller/orders/${e.order.id}`}>{reasonText(e)}</Link> : reasonText(e)}
                          </td>
                          <td className="num">{signed(e.amount)}</td>
                          <td className="num">{e.balanceAfter === null ? "—" : won(e.balanceAfter)}</td>
                          <td data-card="status">
                            <span className={`bdg ${STATUS[e.status].cls}`}>{STATUS[e.status].label}</span>
                          </td>
                          <td data-card="actions">
                            {e.status === "FAILED" && (
                              canEdit && (live !== true ? <button className="btn btn-sm btn-out" type="button" disabled aria-label={`${e.member.broadcastNickname ?? "회원"} 지급 재시도`}>재시도</button> : <Link className="btn btn-sm btn-out" href={detailHref(e.id)} onClick={event => void rememberPage(event, detailHref(e.id))} aria-label={`${e.member.broadcastNickname ?? "회원"} 지급 재시도`}>상세</Link>)
                            )}
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
          실제 지급이 꺼져 있으면 모든 지급은 「대기」로만 기록되고, 켜는 순간 대기분이 일괄 지급됩니다.
        </p>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
