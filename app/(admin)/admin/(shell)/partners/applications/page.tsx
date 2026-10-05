"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { Modal, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { MAX_SEARCH_LENGTH } from "../../../../../../components/seller/format";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { formatDateTime } from "../../../../../../lib/client/format";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { text } from "../../../_components/partners";
import { RejectApplicationDialog } from "../../../_components/RejectApplicationDialog";
import { takeFlash } from "../../../_components/flash";
import { useListFilters } from "../../../_components/useListFilters";

// MA-013 가입 신청 목록(GET /api/admin/sellers/applications, 모든 마스터 역할 조회). 정본: design/project/MA-013-OPS.dc.html(FINAL).
// 요약 → 칩(주소 ?tab=) → 상세 검색(접수일·업종·검색어) → 목록. 승인은 확인 창 없이 바로 처리하고 10초 안에 되돌릴 수 있다. 확인 필요 건은 사유를 보고 명시적으로 승인한다.
// 보완 요청 건은 재촉 메일(하루 한 번, 최대 3번). 이상 없는 건만 체크해 선택 승인·선택 반려한다. 처리한 행만 바뀌고(목록 전체를 다시 읽지 않는다) 처리는 최고관리자·운영만 보인다(seller.moderate).
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
  supplement: Supplement | null;
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
type Filters = { tab: string; sort: string; q: string; field: string; industry: string; receivedFrom: string; receivedTo: string };
const EMPTY: Filters = { tab: "all", sort: "oldest", q: "", field: "all", industry: "", receivedFrom: "", receivedTo: "" };
const SEARCH_KEYS = ["q", "field", "industry", "receivedFrom", "receivedTo"] as const;
const LIMIT = 20;
const MAX_REASON = 200;

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

function SupplementDialog({ row, onClose, onDone, onStale }: { row: Row; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = reason.trim().length;
  const invalid = count === 0 || count > MAX_REASON;
  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/sellers/${encodeURIComponent(row.id)}/supplement`, { method: "POST", json: { reason: reason.trim() } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 404) return onStale();
    setError(failMessage(r, "보완 요청을 하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="supplement-title" busy={busy} dirty={reason !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="supplement-title">
              보완을 요청하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">{row.shopName} 신청자에게 사유가 그대로 발송되고, 7일 안에 보완하지 않으면 자동 반려됩니다.</span>
          </div>
          <div className="col" style={{ gap: 6, padding: "0 24px" }}>
            <textarea className="inp" rows={3} aria-label="보완 요청 사유" placeholder="보완이 필요한 내용" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
            <span className={`t-c1 ${count > MAX_REASON ? "c-neg" : "c-alt"}`}>
              {count}/{MAX_REASON}
            </span>
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy || invalid}>
              {busy ? "처리 중" : "보완 요청"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Applications() {
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const { applied, draft, setDraft, apply } = useListFilters(EMPTY);
  const tab = CHIPS.some(([k]) => k === applied.tab) ? applied.tab : "all";
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [bulkRejecting, setBulkRejecting] = useState(false);
  const [reviewing, setReviewing] = useState<Row | null>(null);
  const [supplementing, setSupplementing] = useState<Row | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const reqId = useRef(0);
  const cursor = cursors[cursors.length - 1];
  const key = JSON.stringify({ ...applied, tab, cursor });

  const load = useCallback(
    async (silent = false) => {
      const id = ++reqId.current;
      if (!silent) setState({ kind: "loading" });
      const p = new URLSearchParams({ tab, sort: applied.sort === "newest" ? "newest" : "oldest", limit: String(LIMIT) });
      for (const k of SEARCH_KEYS) if (applied[k] && !(k === "field" && !applied.q)) p.set(k, applied[k]);
      if (cursor) p.set("cursor", cursor);
      const r = await adminApi<Data>(`/api/admin/sellers/applications?${p}`);
      if (id !== reqId.current) return;
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
  // 되돌릴 수 있는 승인이 있는 동안만 1초마다 갱신한다
  const hasUndo = state.kind === "ok" && state.rows.some((r) => r.undoUntil && r.undoUntil > now);
  useEffect(() => {
    if (!hasUndo) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasUndo]);

  const rows = state.kind === "ok" ? state.rows : [];
  const patchRows = (fn: (rows: Row[]) => Row[]) => setState((s) => (s.kind === "ok" ? { ...s, rows: fn(s.rows) } : s));
  const mark = (id: string, patch: Partial<Row> | "gone") => patchRows((rs) => (patch === "gone" ? rs.filter((r) => r.id !== id) : rs.map((r) => (r.id === id ? { ...r, ...patch } : r))));
  const unpick = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : s));
  const setBusyId = (id: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const stale = (r: Row) => {
    mark(r.id, "gone");
    unpick(r.id);
    setToast({ text: `${r.shopName}은(는) 다른 곳에서 이미 처리됐습니다.`, neg: true });
  };
  const approve = async (r: Row) => {
    if (busy.has(r.id)) return;
    setBusyId(r.id, true);
    const res = await adminApi<{ undoableUntil?: string }>(`/api/admin/sellers/${encodeURIComponent(r.id)}/approve`, { method: "POST", json: {} });
    setBusyId(r.id, false);
    if (res.ok) {
      unpick(r.id);
      mark(r.id, { done: "approved", undoUntil: res.data.undoableUntil ? new Date(res.data.undoableUntil).getTime() : undefined });
      setNow(Date.now());
      return setToast({ text: `${r.shopName} 가입을 승인했습니다. 10초 안에 되돌릴 수 있습니다.` });
    }
    if (res.status === 404 || res.status === 409) return stale(r);
    setToast({ text: failMessage(res, `${r.shopName} 승인을 하지 못했습니다. 목록은 바뀌지 않았습니다. 잠시 후 다시 시도해 주십시오.`), neg: true });
  };
  const undo = async (r: Row) => {
    if (busy.has(r.id)) return;
    setBusyId(r.id, true);
    const res = await adminApi(`/api/admin/sellers/${encodeURIComponent(r.id)}/approve/undo`, { method: "POST", json: {} });
    setBusyId(r.id, false);
    if (res.ok) {
      setToast({ text: `${r.shopName} 승인을 되돌렸습니다.` });
      return void load(true);
    }
    mark(r.id, { undoUntil: undefined });
    setToast({ text: failMessage(res, `${r.shopName} 승인을 되돌리지 못했습니다.`), neg: true });
  };
  const remind = async (r: Row) => {
    if (busy.has(r.id)) return;
    setBusyId(r.id, true);
    const res = await adminApi<{ reminderCount: number }>(`/api/admin/sellers/${encodeURIComponent(r.id)}/remind`, { method: "POST", json: {} });
    setBusyId(r.id, false);
    if (res.ok) {
      patchRows((rs) => rs.map((x) => (x.id === r.id && x.supplement ? { ...x, supplement: { ...x.supplement, reminderCount: res.data.reminderCount, lastReminderAt: new Date().toISOString() } } : x)));
      return setToast({ text: `${r.shopName} 신청자에게 재촉 메일을 보냈습니다.` });
    }
    setToast({ text: failMessage(res, `${r.shopName} 재촉 메일을 보내지 못했습니다.`), neg: true });
  };
  const applyBulk = (results: Bulk[], okMark: (b: Bulk) => Partial<Row>, noun: string, done: string) => {
    const failed = results.filter((b) => !b.ok);
    patchRows((rs) => rs.map((r) => (results.find((b) => b.id === r.id && b.ok) ? { ...r, ...okMark(results.find((b) => b.id === r.id)!) } : r)));
    setPicked(new Set(failed.map((b) => b.id)));
    setNow(Date.now());
    const first = failed[0];
    const name = first && rows.find((r) => r.id === first.id)?.shopName;
    setToast({ text: `${noun} ${results.length - failed.length}건${failed.length ? ` · 실패 ${failed.length}건 — ${name ?? ""}: ${first.message ?? "처리하지 못했습니다"}` : done}`, neg: failed.length > 0 });
  };
  const bulkApprove = async () => {
    const ids = [...picked];
    if (!ids.length) return;
    setBusy((b) => new Set([...b, ...ids]));
    const res = await adminApi<{ results: Bulk[] }>("/api/admin/sellers/applications/bulk-approve", { method: "POST", json: { ids } });
    setBusy((b) => new Set([...b].filter((x) => !ids.includes(x))));
    if (!res.ok) return setToast({ text: failMessage(res, "선택 승인을 하지 못했습니다. 목록은 바뀌지 않았습니다."), neg: true });
    applyBulk(res.data.results, (b) => ({ done: "approved", undoUntil: b.undoableUntil ? new Date(b.undoableUntil).getTime() : undefined }), "승인", "을 승인했습니다");
  };

  const open = rows.filter((r) => !r.done);
  const checkable = open.filter((r) => r.state === "CLEAR");
  const allPicked = checkable.length > 0 && checkable.every((r) => picked.has(r.id));
  const togglePick = (id: string) => setPicked((s) => new Set(s.has(id) ? [...s].filter((x) => x !== id) : [...s, id]));
  const data = state.kind === "ok" ? state.data : null;
  const k = data?.kpi;
  const search = () => {
    setCursors([null]);
    setPicked(new Set());
    apply({ ...applied, ...draft, tab });
  };
  const reset = () => {
    setCursors([null]);
    setPicked(new Set());
    apply({ ...applied, q: "", field: "all", industry: "", receivedFrom: "", receivedTo: "" });
  };
  const setFilter = (patch: Partial<Filters>) => {
    setCursors([null]);
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
        <PageHead title="가입 신청" />
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
          </div>
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
          <div className="card">
            {canModerate && picked.size > 0 && (
              <div className="row" style={{ gap: 8, padding: "8px 12px", background: "var(--info-bg)" }} data-testid="bulk-bar">
                <b>{picked.size}개 선택</b>
                <span className="t-c1 c-alt">이상 없는 신청만 일괄 승인 대상입니다. 확인 필요 · 보완 요청 건은 체크할 수 없습니다.</span>
                <span className="row" style={{ marginLeft: "auto", gap: 8 }}>
                  <button className="btn btn-sm" type="button" onClick={() => void bulkApprove()}>
                    선택 승인
                  </button>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => setBulkRejecting(true)}>
                    선택 반려
                  </button>
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
                        const working = busy.has(r.id);
                        const canUndo = r.done === "approved" && !!r.undoUntil && r.undoUntil > now;
                        return (
                          <tr key={r.id} data-testid="application-row" data-done={r.done ?? ""} style={r.done ? { opacity: 0.5 } : undefined}>
                            {canModerate && (
                              <td>
                                <input type="checkbox" aria-label={`${r.shopName} 선택`} checked={picked.has(r.id)} disabled={r.done !== undefined || r.state !== "CLEAR"} onChange={() => togglePick(r.id)} />
                              </td>
                            )}
                            <td className="col-text">
                              <Link className="fw6" href={`/admin/partners/applications/${r.id}`}>
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
                                <span className="c-alt">{r.done === "approved" ? (canUndo ? "승인했습니다. 10초 안에 되돌릴 수 있습니다." : "승인했습니다.") : "반려했습니다."}</span>
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
                              <div className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                                {r.done ? (
                                  <>
                                    {canUndo && canModerate && (
                                      <button className="btn btn-sm btn-out" type="button" onClick={() => void undo(r)} disabled={working}>
                                        되돌리기 ({Math.max(0, Math.ceil((r.undoUntil! - now) / 1000))}초)
                                      </button>
                                    )}
                                    {r.done === "approved" && (
                                      <Link className="btn btn-sm btn-out" href={`/admin/partners/${r.id}`}>
                                        파트너스
                                      </Link>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    {canModerate && r.state === "CLEAR" && (
                                      <>
                                        <button className="btn btn-sm" type="button" onClick={() => void approve(r)} disabled={working}>
                                          {working ? "처리 중" : "승인"}
                                        </button>
                                        <button className="btn btn-sm btn-out" type="button" onClick={() => setRejecting(r)} disabled={working}>
                                          반려
                                        </button>
                                      </>
                                    )}
                                    {canModerate && r.state === "REVIEW" && (
                                      <button className="btn btn-sm" type="button" onClick={() => setReviewing(r)} disabled={working}>
                                        확인할 내용 보기
                                      </button>
                                    )}
                                    {canModerate && r.state === "SUPPLEMENT" && (
                                      <button className="btn btn-sm btn-out" type="button" onClick={() => void remind(r)} disabled={working || (r.supplement?.reminderCount ?? 0) >= 3}>
                                        재촉 메일
                                      </button>
                                    )}
                                    <Link className="btn btn-sm btn-out" href={`/admin/partners/applications/${r.id}`}>
                                      상세
                                    </Link>
                                  </>
                                )}
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
              <div className="row" style={{ gap: 8, justifyContent: "center", padding: 12 }}>
                <button className="btn btn-sm btn-out" type="button" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
                  ‹ 이전
                </button>
                <button className="btn btn-sm btn-out" type="button" disabled={!data?.nextCursor} onClick={() => data?.nextCursor && setCursors((c) => [...c, data.nextCursor])}>
                  다음 ›
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      {rejecting && (
        <RejectApplicationDialog
          id={rejecting.id}
          shopName={rejecting.shopName}
          onClose={() => setRejecting(null)}
          onDone={() => {
            const r = rejecting;
            setRejecting(null);
            setReviewing(null);
            unpick(r.id);
            mark(r.id, { done: "rejected" });
            setToast({ text: `${r.shopName} 가입을 반려했습니다.` });
          }}
          onStale={() => {
            const r = rejecting;
            setRejecting(null);
            setReviewing(null);
            stale(r);
          }}
        />
      )}
      {bulkRejecting && (
        <RejectApplicationDialog
          bulkIds={[...picked]}
          shopName={`선택한 ${picked.size}건`}
          onClose={() => setBulkRejecting(false)}
          onDone={(res) => {
            setBulkRejecting(false);
            if (res) applyBulk(res, () => ({ done: "rejected" }), "반려", "을 반려했습니다");
          }}
          onStale={() => setBulkRejecting(false)}
        />
      )}
      {supplementing && (
        <SupplementDialog
          row={supplementing}
          onClose={() => setSupplementing(null)}
          onDone={() => {
            const r = supplementing;
            setSupplementing(null);
            setReviewing(null);
            unpick(r.id);
            setToast({ text: `${r.shopName} 신청자에게 보완을 요청했습니다.` });
            void load(true);
          }}
          onStale={() => {
            const r = supplementing;
            setSupplementing(null);
            setReviewing(null);
            stale(r);
          }}
        />
      )}
      {reviewing && !rejecting && !supplementing && (
        <Modal labelId="review-title" busy={busy.has(reviewing.id)} onClose={() => setReviewing(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="review-title">
                  {reviewing.shopName} 가입 신청에서 확인할 것
                </h2>
                <span className="t-l2 c-alt">아래 사유를 확인한 뒤 승인해 주십시오. 자세한 서류는 상세에서 볼 수 있습니다.</span>
              </div>
              <div className="col" style={{ gap: 8, padding: "0 24px" }}>
                <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="review-reasons">
                  {reviewing.reasons.map((c) => (
                    <li key={c.code}>{c.text}</li>
                  ))}
                </ul>
                <span className="t-l2 c-alt">
                  {reviewing.applicantName} · {text(reviewing.businessNumber)} · {formatDateTime(reviewing.receivedAt)} 접수
                </span>
              </div>
              <div className="modal-f">
                <Link className="btn btn-out" href={`/admin/partners/applications/${reviewing.id}`}>
                  상세 열기
                </Link>
                <button className="btn btn-out" type="button" onClick={() => setSupplementing(reviewing)} disabled={busy.has(reviewing.id)}>
                  보완 요청
                </button>
                <button className="btn btn-out" type="button" onClick={() => setRejecting(reviewing)} disabled={busy.has(reviewing.id)}>
                  반려
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy.has(reviewing.id)}
                  onClick={() => {
                    const r = reviewing;
                    setReviewing(null);
                    void approve(r);
                  }}
                >
                  확인했습니다. 승인
                </button>
                <button className="btn btn-out" type="button" onClick={requestClose}>
                  닫기
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
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
