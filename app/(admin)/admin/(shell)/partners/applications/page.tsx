"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { CursorPagination, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { MAX_SEARCH_LENGTH } from "../../../../../../components/seller/format";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { formatDateTime } from "../../../../../../lib/client/format";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { text } from "../../../_components/partners";
import { RejectApplicationDialog } from "../../../_components/RejectApplicationDialog";
import { SupplementDialog } from "../../../_components/SupplementDialog";
import { LicenseValue, type License } from "../../../_components/LicenseValue";
import { takeFlash } from "../../../_components/flash";
import { listDefaults } from "../../../../../../lib/client/filterDefaults";
import { selectionHref } from "../../../_components/selection";
import { useListFilters } from "../../../_components/useListFilters";

// MA-013 가입 신청 목록(GET /api/admin/sellers/applications, 모든 마스터 역할 조회). 정본: design/project/MA-013-OPS.dc.html(FINAL).
// 요약 → 칩(주소 ?tab=) → 상세 검색 → 읽기·선택 목록. 승인·반려·보완·되돌리기는 실제 상세에서 처리한다.
// 이상 없는 건만 선택해 선택 처리 상세로 이동한다. 처리 권한·재촉 제한·10초 되돌리기는 기존 서버가 검증한다.
type State = "CLEAR" | "REVIEW" | "SUPPLEMENT";
type Supplement = { reason: string; requestedAt: string; dueAt: string; dueExpired: boolean; daysLeft: number; reminderCount: number; lastReminderAt: string | null; canRemindAt: string | null };
type App = {
  id: string;
  slug: string;
  shopName: string;
  state: State;
  applicantName: string;
  applicantEmail: string;
  businessNumber: string | null;
  industry: string | null;
  receivedAt: string;
  elapsedHours: number;
  over48h: boolean;
  reasons: { code: string; text: string }[];
  checks: { key: string; label: string; result: "OK" | "WARN" | "FAIL" | "NONE"; text: string }[];
  checkedAt: string | null;
  supplement: Supplement | null;
  license: License | null;
  businessAddress: string | null;
  channelUrl: string | null;
};
type Row = App & { done?: "approved" | "rejected"; undoUntil?: number };
type Kpi = { pending: number; needsReview: number; clear: number; supplement: number; over48h: number; receivedToday: number; approvedToday: number; autoApprovedToday: number; rejectedToday: number; avgHandlingHours: { thisWeek: number | null; lastWeek: number | null } };
type Data = { chips: Record<"all" | "clear" | "review" | "supplement" | "over48h" | "today", number>; kpi: Kpi; industries: string[]; total: number; nextCursor: string | null; applications: App[] };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data; rows: Row[] };
type Bulk = { id: string; ok: boolean; message?: string; undoableUntil?: string };

const CHIPS = [
  ["all", "전체", "all"],
  ["clear", "이상 없음", "clear"],
  ["review", "확인 필요", "review"],
  ["supplement", "보완 요청", "supplement"],
  ["over48h", "48시간 초과", "over48h"],
  ["today", "오늘 접수", "today"],
] as const;
const FIELDS = [
  ["all", "전체"],
  ["shop", "쇼핑몰명"],
  ["applicant", "신청자"],
  ["biz", "사업자등록번호"],
] as const;
// 승인 대기 업무 큐라 공통 기본 기간(최근 1개월)을 쓰지 않는다(오래 기다린 신청이 가려지면 안 됨, period: null). 정렬은 큐 정본대로 오래된 순이 기본, 현재 쪽 크기는 10.
const EMPTY = listDefaults({ size: "10", tab: "all", sort: "oldest", q: "", field: "all", industry: "", receivedFrom: "", receivedTo: "" }, { period: null });
type Filters = typeof EMPTY;
const SEARCH_KEYS = ["q", "field", "industry", "receivedFrom", "receivedTo"] as const;

function waited(r: App): { label: string; hot: boolean } {
  if (r.supplement) {
    const days = Math.max(1, Math.floor((Date.now() - new Date(r.supplement.requestedAt).getTime()) / 86_400_000));
    return { label: r.supplement.dueExpired ? `보완 요청 ${days}일째 · 기한 지남` : `보완 요청 ${days}일째 · ${r.supplement.daysLeft}일 남음`, hot: r.supplement.dueExpired };
  }
  const h = r.elapsedHours;
  const base = h < 1 ? "1시간 안" : h < 24 ? `${h}시간 전` : `승인 대기 ${Math.floor(h / 24)}일째`;
  return { label: r.over48h ? `${base} · 48시간 초과` : base, hot: r.over48h };
}
const hours = (v: number | null) => (v === null ? "-" : `${Math.round(v * 10) / 10}시간`);

function Applications() {
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const { applied, draft, setDraft, apply } = useListFilters(EMPTY);
  const tab = CHIPS.some(([k]) => k === applied.tab) ? applied.tab : "all";
  const searchFilterKey = JSON.stringify([applied.q, applied.industry, applied.receivedFrom, applied.receivedTo]);
  const hasSearchFilters = Boolean(applied.q || applied.industry || applied.receivedFrom || applied.receivedTo);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [searchOpen, setSearchOpen] = useState(hasSearchFilters);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [cursorPage, setCursorPage] = useState(1);
  const paging = useRef(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);
  const cursor = cursors[cursorPage - 1];
  const key = JSON.stringify({ ...applied, tab, cursor });

  useEffect(() => {
    if (hasSearchFilters) setSearchOpen(true);
  }, [searchFilterKey, hasSearchFilters]);

  const load = useCallback(
    async (silent = false) => {
      const id = ++reqId.current;
      paging.current = true;
      if (!silent) setState({ kind: "loading" });
      const p = new URLSearchParams({ tab, sort: applied.sort === "newest" ? "newest" : "oldest", limit: "10" });
      for (const k of SEARCH_KEYS) if (applied[k] && !(k === "field" && !applied.q)) p.set(k, applied[k]);
      if (cursor) p.set("cursor", cursor);
      const r = await adminApi<Data>(`/api/admin/sellers/applications?${p}`);
      if (id !== reqId.current) return;
      paging.current = false;
      if (r.ok) setState({ kind: "ok", data: r.data, rows: r.data.applications });
      else if (!silent) setState({ kind: "error" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const m = takeFlash();
    if (m) setToast({ text: m });
  }, []);
  useScrollRestore("admin-applications", state.kind === "ok");
  const rows = state.kind === "ok" ? state.rows : [];
  const open = rows.filter((r) => !r.done);
  const checkable = open.filter((r) => r.state === "CLEAR");
  const allPicked = checkable.length > 0 && checkable.every((r) => picked.has(r.id));
  const togglePick = (id: string) => setPicked((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));
  const data = state.kind === "ok" ? state.data : null;
  const k = data?.kpi;
  const search = () => {
    setCursors([null]);
    setCursorPage(1);
    setPicked(new Set());
    apply({ ...applied, ...draft, tab });
  };
  const reset = () => {
    setCursors([null]);
    setCursorPage(1);
    setPicked(new Set());
    apply({ ...applied, q: "", field: "all", industry: "", receivedFrom: "", receivedTo: "" });
  };
  const setFilter = (patch: Partial<Filters>) => {
    setCursors([null]);
    setCursorPage(1);
    setPicked(new Set());
    apply({ ...applied, ...patch });
  };
  const kpiCard = (label: string, value: string, sub?: string, hot?: boolean) => (
    <div className="card" style={{ padding: 16 }}>
      <div className="t-c1 c-alt">{label}</div>
      <div className={`t-h2 fw6 ${hot ? "c-neg" : ""}`}>{value}</div>
      {sub && <div className="t-c1 c-alt">{sub}</div>}
    </div>
  );

  return (
    <>
      <AdminTopbar crumb="파트너스 › 가입 신청" />
      <main className="main">
        <PageHead title="가입 신청" description="목록에서 상태를 확인하고, 필요한 행이나 선택한 항목을 바로 처리합니다." />
        <div className="col" style={{ gap: 16 }}>
          {k && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }} data-testid="application-kpi">
              {kpiCard("가입 신청 중", `${k.pending}`, `이상 없음 ${k.clear} · 확인 필요 ${k.needsReview} · 보완 요청 ${k.supplement}`)}
              {kpiCard("48시간 초과", `${k.over48h}`, undefined, k.over48h > 0)}
              {kpiCard("오늘 접수", `${k.receivedToday}`)}
              {kpiCard("오늘 승인 · 반려", `${k.approvedToday + k.autoApprovedToday} · ${k.rejectedToday}`)}
              {kpiCard("평균 처리", hours(k.avgHandlingHours.thisWeek), `지난주 ${hours(k.avgHandlingHours.lastWeek)}`)}
            </div>
          )}
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="보기">
            {CHIPS.map(([v, label, c]) => (
              <button key={v} type="button" className={`btn btn-sm ${tab === v ? "" : "btn-out"}`} aria-pressed={tab === v} onClick={() => setFilter({ tab: v })}>
                {label}
                {data && ` ${data.chips[c]}`}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-sm btn-out"
              aria-expanded={searchOpen}
              aria-controls="application-search"
              onClick={() => setSearchOpen((open) => !open)}
              style={{ marginLeft: "auto" }}
            >
              상세 검색{hasSearchFilters ? " · 조건 적용 중" : ""} {searchOpen ? "접기" : "펼치기"}
            </button>
          </div>
          <div id="application-search" hidden={!searchOpen}>
            <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
              <SearchRow label="접수일">
                <input className="inp" type="date" aria-label="접수 시작일" value={draft.receivedFrom} onChange={(e) => setDraft({ ...draft, receivedFrom: e.target.value })} />
                ~
                <input className="inp" type="date" aria-label="접수 종료일" value={draft.receivedTo} onChange={(e) => setDraft({ ...draft, receivedTo: e.target.value })} />
              </SearchRow>
              <SearchRow label="업종">
                <select className="inp" aria-label="업종" value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })}>
                  <option value="">전체</option>
                  {(data?.industries ?? []).map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </SearchRow>
              <SearchRow label="검색어">
                <select className="inp" aria-label="검색 칸" value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })}>
                  {FIELDS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <input className="inp" type="search" aria-label="검색어" placeholder="검색어" maxLength={MAX_SEARCH_LENGTH} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
              </SearchRow>
            </SearchBox>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="card" style={{ flex: "1 1 560px", minWidth: 0 }}>
            {canModerate && picked.size > 0 && (
              <div className="row" style={{ gap: 8, padding: "8px 12px", background: "var(--info-bg)" }} data-testid="bulk-bar">
                <b>{picked.size}개 선택</b>
                <span className="t-c1 c-alt">이상 없는 신청만 일괄 승인 대상입니다. 확인 필요 · 보완 요청 건은 체크할 수 없습니다.</span>
                <span className="row" style={{ marginLeft: "auto", gap: 8 }}>
                  <Link className="btn btn-sm" href={selectionHref("/admin/partners/applications/bulk", [...picked], `/admin/partners/applications?${new URLSearchParams(applied)}`) + "&mode=approve"}>
                    선택 승인 상세
                  </Link>
                  <Link className="btn btn-sm btn-out" href={selectionHref("/admin/partners/applications/bulk", [...picked], `/admin/partners/applications?${new URLSearchParams(applied)}`) + "&mode=reject"}>
                    선택 반려 상세
                  </Link>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => setPicked(new Set())}>
                    선택 해제
                  </button>
                </span>
              </div>
            )}
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="가입 신청을 불러오지 못했습니다." onRetry={() => void load()} />}
            {state.kind === "ok" &&
              (rows.length === 0 ? (
                <div className="st">
                  <span className="t">{tab === "all" && !applied.q && !applied.industry && !applied.receivedFrom && !applied.receivedTo ? "처리할 가입 신청이 없습니다." : "조건에 맞는 가입 신청이 없습니다."}</span>
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        {canModerate && (
                          <th style={{ width: 36 }}>
                            <input
                              type="checkbox"
                              aria-label="이상 없는 신청 전체 선택"
                              checked={allPicked}
                              disabled={checkable.length === 0}
                              onChange={() => setPicked(allPicked ? new Set() : new Set(checkable.map((r) => r.id)))}
                            />
                          </th>
                        )}
                        <th>쇼핑몰 · 신청자</th>
                        <th>사업자</th>
                        <th>업종</th>
                        <th>
                          <button type="button" className="btn btn-sm btn-out" onClick={() => setFilter({ sort: applied.sort === "newest" ? "oldest" : "newest" })} aria-label="신청일 정렬 바꾸기">
                            신청일 · 경과 {applied.sort === "newest" ? "↓" : "↑"}
                          </button>
                        </th>
                        <th>확인</th>
                        <th>상태</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const w = waited(r);
                        const working = false;
                        return (
                          <tr key={r.id} data-testid="application-row" data-done={r.done ?? ""} style={r.done ? { opacity: 0.5 } : undefined}>
                            {canModerate && (
                              <td>
                                <input type="checkbox" aria-label={`${r.shopName} 선택`} checked={picked.has(r.id)} disabled={r.done !== undefined || r.state !== "CLEAR"} onChange={() => togglePick(r.id)} />
                              </td>
                            )}
                            <td className="col-text">
                              <Link className="fw6" href={`/admin/partners/applications/${r.id}?returnTo=${encodeURIComponent(`/admin/partners/applications?${new URLSearchParams(applied)}`)}`}>
                                {r.shopName}
                              </Link>
                              {(r.applicantName || r.applicantEmail) && (
                                <span className="t-c1 c-alt" style={{ display: "block" }}>
                                  {[r.applicantName, r.applicantEmail].filter(Boolean).join(" · ")}
                                </span>
                              )}
                            </td>
                            <td className="col-text">{text(r.businessNumber)}</td>
                            <td className="col-text">{text(r.industry)}</td>
                            <td>
                              {formatDateTime(r.receivedAt)}
                              <span className={`t-c1 ${w.hot ? "c-neg fw6" : "c-alt"}`} style={{ display: "block" }}>
                                {w.label}
                              </span>
                            </td>
                            <td className="col-text" data-testid={r.state === "REVIEW" ? "review-summary" : undefined}>
                              {r.done ? (
                                <span className="c-alt">{r.done === "approved" ? "승인했습니다." : "반려했습니다."}</span>
                              ) : r.state === "CLEAR" ? (
                                "자동으로 확인한 결과 이상 없음"
                              ) : r.state === "REVIEW" ? (
                                <>
                                  {r.reasons[0]?.text ?? "확인이 필요합니다"}
                                  {r.reasons.length > 1 && <span className="c-alt"> 외 {r.reasons.length - 1}건</span>}
                                </>
                              ) : (
                                <>
                                  {r.supplement?.reason}
                                  <span className="c-alt"> · 재제출 대기{r.supplement && r.supplement.reminderCount > 0 ? ` · 재촉 ${r.supplement.reminderCount}회` : ""}</span>
                                </>
                              )}
                            </td>
                            <td>
                              {r.done ? (
                                <span className={`bdg ${r.done === "approved" ? "b-done" : "b-gray"}`}>{r.done === "approved" ? "승인됨" : "반려됨"}</span>
                              ) : r.state === "REVIEW" ? (
                                <span className="bdg b-warn">확인 필요 {r.reasons.length}</span>
                              ) : r.state === "SUPPLEMENT" ? (
                                <span className="bdg b-info">보완 요청</span>
                              ) : (
                                <span className="bdg b-done">확인할 것 없음</span>
                              )}
                            </td>
                            <td>
                              <div className="acts2">
                                <Link className="btn btn-sm btn-out" href={`/admin/partners/applications/${r.id}?returnTo=${encodeURIComponent(`/admin/partners/applications?${new URLSearchParams(applied)}`)}`}>상세</Link>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            {state.kind === "ok" && (cursors.length > 1 || data?.nextCursor) && (
              <CursorPagination page={cursorPage} visited={cursors.length} hasNext={!!data?.nextCursor} onChange={(page) => { if (state.kind !== "ok" || paging.current || page === cursorPage) return; paging.current = true; setCursorPage(page); }} onNext={() => { if (state.kind === "ok" && !paging.current && data?.nextCursor) { paging.current = true; setCursors(c => c.length === cursorPage ? [...c, data.nextCursor] : c); setCursorPage(cursorPage + 1); } }} />
            )}
          </div>
          </div>
        </div>
      </main>

      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

export default function PartnerApplications() {
  return (
    <Suspense fallback={null}>
      <Applications />
    </Suspense>
  );
}
