"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../lib/server/authz/permissions";
import { DateRangePicker, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { ListHead, Pagination } from "../../../../../components/admin-ui/ListTable";
import { ErrorState, LoadingRows, Toast } from "../../../../../components/seller/States";
import { MAX_SEARCH_LENGTH } from "../../../../../components/seller/format";
import { adminApi } from "../../_components/api";
import { AdminTopbar, useAdmin } from "../../_components/AdminShell";
import { ImpersonateDialog } from "../../_components/ImpersonateDialog";
import { DISPLAY_STATUS, PLAN_FILTER, ago, day, type DisplayStatus, type SellerListRow, type SellerListSummary } from "../../_components/partners";
import { useListFilters } from "../../_components/useListFilters";
import { useScrollRestore } from "../../../../../lib/client/navigation";

// MA-011 파트너스 목록(GET /api/admin/sellers, 모든 마스터 역할). 정본: design/project/MA-011.dc.html(FINAL).
// 위쪽 요약 칩 → 검색 조건 → 목록(정렬·쪽 크기·번호형 쪽 이동). 칩·정렬·쪽은 누르는 즉시 적용되고 검색 조건은 「검색」을 눌러 적용한다. 모든 조건은 주소에 남는다.
// 이용 정지·해제(MA-015)는 상세(MA-012)에서만 한다. 대리 조회(MA-016)는 최고관리자·운영·고객 지원만 버튼이 보인다. 엑셀 내려받기에는 대표자 연락처가 들어 있지 않다.
type Filters = {
  q: string;
  field: string;
  state: string;
  plan: string;
  pg: string;
  live: string;
  payout: string;
  note: string;
  joinedFrom: string;
  joinedTo: string;
  active: string;
  sort: string;
  limit: string;
  page: string;
};
const EMPTY: Filters = { q: "", field: "all", state: "", plan: "", pg: "", live: "", payout: "", note: "", joinedFrom: "", joinedTo: "", active: "", sort: "joined", limit: "20", page: "1" };
// 「초기화」는 검색 조건만 비우고 정렬·쪽 크기는 그대로 둔다
const SEARCH_KEYS = ["q", "field", "state", "plan", "pg", "live", "payout", "note", "joinedFrom", "joinedTo", "active"] as const;
type Data = { sellers: SellerListRow[]; total: number; summary: SellerListSummary };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };

const FIELDS = [
  ["all", "전체"],
  ["shop", "쇼핑몰 이름"],
  ["rep", "대표자"],
  ["email", "이메일"],
  ["slug", "쇼핑몰 주소"],
  ["biz", "사업자등록번호"],
] as const;
const STATES: DisplayStatus[] = ["NORMAL", "TRIAL", "OVERDUE", "LOCKED", "SUSPENDED", "CLOSED"];
const PG_STATUS = [
  ["OK", "연결됨"],
  ["ERROR", "오류"],
  ["NONE", "미연결"],
] as const;
const ACTIVE = [
  ["7d", "7일 안"],
  ["30d", "30일 안"],
  ["inactive30", "30일 넘게 없음"],
] as const;
const SORTS = [
  ["activity", "최근 활동순"],
  ["joined", "가입일순"],
  ["orders", "주문 많은순"],
  ["overdue", "연체 먼저"],
] as const;

function params(f: Filters, withPaging: boolean) {
  const p = new URLSearchParams();
  for (const k of SEARCH_KEYS) {
    if (f[k] && !(k === "field" && (f.q === "" || f.field === "all"))) p.set(k, f[k]);
  }
  p.set("sort", f.sort);
  if (withPaging) {
    const limit = Number(f.limit);
    p.set("limit", String(limit));
    const offset = (Math.max(1, Number(f.page) || 1) - 1) * limit;
    if (offset > 0) p.set("cursor", String(offset));
    p.set("summary", "1");
  }
  return p.toString();
}

function PartnerList() {
  const { me } = useAdmin();
  const canImpersonate = adminCan(me.role, "seller.impersonate");
  const { applied, draft, setDraft, apply } = useListFilters<Filters>(EMPTY);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [viewing, setViewing] = useState<SellerListRow | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Data>(`/api/admin/sellers?${params(f, true)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  useScrollRestore("admin-partners", state.kind === "ok");

  // 정렬·쪽 크기를 연달아 바꿔도 앞의 변경이 사라지지 않게, 마지막으로 보낸 조건을 따로 들고 있다가 거기에 얹는다
  const latest = useRef(applied);
  useEffect(() => {
    latest.current = applied;
  }, [applied]);
  const go = (patch: Partial<Filters>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    apply(next);
  };
  const set = (patch: Partial<Filters>) => go({ ...patch, page: "1" });
  const limit = Number(applied.limit) || 20;
  const page = Math.max(1, Number(applied.page) || 1);
  const data = state.kind === "ok" ? state.data : null;
  const sum = data?.summary ?? null;
  const filtered = SEARCH_KEYS.some((k) => k !== "field" && applied[k] !== "");

  const search = () => go({ ...draft, q: draft.q.trim(), sort: latest.current.sort, limit: latest.current.limit, page: "1" });
  const reset = () => go({ ...EMPTY, sort: latest.current.sort, limit: latest.current.limit });

  const chips: { label: string; count: string | null; on: boolean; patch: Partial<Filters> }[] = [
    { label: "전체", count: sum ? String(sum.total) : null, on: !applied.state && !applied.pg && !applied.live && !applied.payout, patch: { state: "", pg: "", live: "", payout: "" } },
    { label: "정상", count: sum ? String(sum.normal) : null, on: applied.state === "NORMAL", patch: { state: "NORMAL" } },
    { label: "체험 중", count: sum ? String(sum.trial) : null, on: applied.state === "TRIAL", patch: { state: "TRIAL" } },
    { label: "연체", count: sum ? String(sum.overdue) : null, on: applied.state === "OVERDUE", patch: { state: "OVERDUE" } },
    { label: "이용 정지", count: sum ? String(sum.suspended) : null, on: applied.state === "SUSPENDED", patch: { state: "SUSPENDED" } },
    { label: "카드 결제 연결 오류 · 미연결", count: sum ? `${sum.pgError} / ${sum.pgNone}` : null, on: applied.pg === "ERROR", patch: { pg: "ERROR" } },
    { label: "실제 지급 켜짐", count: sum ? String(sum.payoutEnabled) : null, on: applied.payout === "1", patch: { payout: "1" } },
    { label: "지금 방송 중", count: sum ? String(sum.live) : null, on: applied.live === "1", patch: { live: "1" } },
  ];

  return (
    <>
      <AdminTopbar crumb="파트너스 › 파트너스 목록" />
      <main className="main">
        <PageHead
          title="파트너스 목록"
          actions={
            <>
              <Link className="btn btn-out" href="/admin/partners/applications">
                가입 신청{sum && sum.pendingApplications > 0 ? ` ${sum.pendingApplications}` : ""}
              </Link>
              <a className="btn btn-out" href={`/api/admin/sellers/export?${params(applied, false)}`} download>
                엑셀 내려받기
              </a>
            </>
          }
        />
        <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))", marginBottom: 12, overflow: "hidden" }} role="group" aria-label="요약">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className="col"
              style={{ gap: 4, padding: "12px 16px", textAlign: "left", border: 0, borderRight: "1px solid var(--wds-line-normal, #e5e5e5)", background: c.on ? "var(--wds-fill-alternative, #f4f5f7)" : "transparent", cursor: "pointer", minWidth: 0 }}
              aria-pressed={c.on}
              onClick={() => set(c.patch)}
            >
              <span className="t-c1 c-alt">
                {c.label}
              </span>{" "}
              <span className="t-h2 fw6 num" style={{ whiteSpace: "nowrap" }}>
                {c.count ?? "—"}
              </span>
            </button>
          ))}
        </div>
        <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
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
          <SearchRow label="상태">
            {[["", "전체"], ...STATES.map((x) => [x, DISPLAY_STATUS[x].label])].map(([v, l]) => (
              <label key={v} className="chk">
                <input className="chkbox" type="radio" name="f-state" checked={draft.state === v} onChange={() => setDraft({ ...draft, state: v })} />
                {l}
              </label>
            ))}
          </SearchRow>
          <SearchRow label="구독">
            {[["", "전체"], ...PLAN_FILTER.map((p) => [p.code, p.label])].map(([v, l]) => (
              <label key={v} className="chk">
                <input className="chkbox" type="radio" name="f-plan" checked={draft.plan === v} onChange={() => setDraft({ ...draft, plan: v })} />
                {l}
              </label>
            ))}
          </SearchRow>
          <SearchRow label="카드 결제 연결">
            {[["", "전체"], ...PG_STATUS.map(([v, l]) => [v, l])].map(([v, l]) => (
              <label key={v} className="chk">
                <input className="chkbox" type="radio" name="f-pg" checked={draft.pg === v} onChange={() => setDraft({ ...draft, pg: v })} />
                {l}
              </label>
            ))}
          </SearchRow>
          <SearchRow label="기타">
            {(
              [
                ["live", "방송 중만"],
                ["payout", "실제 지급 켜짐"],
                ["note", "확인 필요 메모 있음"],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="chk">
                <input className="chkbox" type="checkbox" checked={draft[k] === "1"} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked ? "1" : "" })} />
                {l}
              </label>
            ))}
          </SearchRow>
          <SearchRow label="가입일">
            <DateRangePicker className="dt-sm" quick fromLabel="가입일 시작" toLabel="가입일 끝" from={draft.joinedFrom} to={draft.joinedTo} onChange={(r) => setDraft({ ...draft, joinedFrom: r.from, joinedTo: r.to })} />
          </SearchRow>
          <SearchRow label="최근 활동">
            <select className="inp" aria-label="최근 활동" value={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.value })}>
              <option value="">전체</option>
              {ACTIVE.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </SearchRow>
        </SearchBox>

        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="파트너스 목록을 불러오지 못했습니다." onRetry={() => void load(applied)} />}
          {data &&
            (data.sellers.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "조건에 맞는 파트너스가 없습니다." : "등록된 파트너스가 없습니다. 가입 신청을 승인하면 여기에 표시됩니다."}</span>
                {filtered && (
                  <button className="btn btn-sm btn-out" type="button" onClick={reset}>
                    조건 초기화
                  </button>
                )}
              </div>
            ) : (
              <>
                <ListHead
                  total={data.total}
                  actions={
                    <span className="row" style={{ gap: 8 }}>
                      <select className="inp" aria-label="정렬" value={applied.sort} onChange={(e) => set({ sort: e.target.value })}>
                        {SORTS.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                      <select className="inp" aria-label="쪽 크기" value={applied.limit} onChange={(e) => set({ limit: e.target.value })}>
                        <option value="20">20개씩</option>
                        <option value="50">50개씩</option>
                      </select>
                    </span>
                  }
                />
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th>파트너스 · 쇼핑몰</th>
                        <th>번호</th>
                        <th>상태</th>
                        <th>구독</th>
                        <th>카드 결제 연결</th>
                        <th>방송</th>
                        <th>이번 달 주문</th>
                        <th>회원</th>
                        <th>가입일</th>
                        <th>최근 활동</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sellers.map((s) => {
                        const overlayOnly = s.plan?.code === "OVERLAY_ONLY";
                        return (
                          <tr key={s.id} data-testid="partner-row">
                            <td>
                              <Link className="fw6" href={`/admin/partners/${s.id}`}>
                                {s.shopName}
                              </Link>
                              <div className="t-c1 c-alt">
                                {s.representativeName ? `${s.representativeName} · ` : ""}쇼핑몰 주소 {s.slug}
                              </div>
                            </td>
                            <td className="num">{s.seq}</td>
                            <td>
                              <span className={`bdg ${DISPLAY_STATUS[s.displayStatus].cls}`}>{DISPLAY_STATUS[s.displayStatus].label}</span>
                            </td>
                            <td>{s.plan?.name ?? "-"}</td>
                            <td>{overlayOnly ? "—" : s.pg.status === "ERROR" ? <span className="bdg b-fail">오류</span> : s.pg.status === "OK" ? <span className="bdg b-done">정상</span> : <span className="bdg b-gray">미연결</span>}</td>
                            <td>{s.live ? <span className="bdg b-live">방송 중</span> : "—"}</td>
                            <td className="num">{s.ordersThisMonth.toLocaleString("ko-KR")}</td>
                            <td className="num">{overlayOnly ? "—" : s.memberCount.toLocaleString("ko-KR")}</td>
                            <td className="num">{day(s.createdAt)}</td>
                            <td>{ago(s.lastActivityAt)}</td>
                            <td>
                              <span className="row" style={{ gap: 6, justifyContent: "center" }}>
                                <Link className="btn btn-sm btn-out" href={`/admin/partners/${s.id}`}>
                                  상세
                                </Link>
                                {canImpersonate && s.status === "ACTIVE" && (
                                  <button className="btn btn-sm btn-out" type="button" onClick={() => setViewing(s)}>
                                    이 파트너스 화면 대신 보기
                                  </button>
                                )}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pagination page={page} pageCount={Math.max(1, Math.ceil(data.total / limit))} onChange={(n) => go({ page: String(n) })} />
              </>
            ))}
        </div>
      </main>
      {viewing && (
        <ImpersonateDialog
          seller={viewing}
          onClose={() => setViewing(null)}
          onDone={(r) => {
            setViewing(null);
            setToast({ text: r.opened ? "대신 보기를 시작했습니다. 새 창에서 파트너스 화면을 읽기 전용으로 봅니다." : "대신 보기를 시작했습니다. 새 창이 막혀 열지 못했습니다. 파트너스 상세에서 다시 열어 주십시오." });
          }}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

export default function PartnerListPage() {
  return (
    <Suspense fallback={null}>
      <PartnerList />
    </Suspense>
  );
}
