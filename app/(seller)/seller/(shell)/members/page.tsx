"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTable, CursorPagination, Modal, PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { DatePicker, DateRangePicker } from "../../../../../components/admin-ui/DatePicker";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, apiDownload } from "../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { MAX_SEARCH_LENGTH, won } from "../../../../../components/seller/format";
import { formatDate, formatDateTime } from "../../../../../lib/client/format";
import { phoneText, type MemberRow } from "../../../../../components/seller/members/types";
import "./members.css";

// SA-041 회원 목록·검색(GET /api/seller/members, 회원·적립금 권한). 현재 10명씩 커서로 조회한다. 정본 v286.
// 검색은 방송 닉네임, 개인정보 열람 권한이 있으면 이름·휴대폰 끝 4자리도 찾는다(서버가 권한에 따라 정함).
// 상태 보존(IA Back 규칙 3항, UX 감사): 조건은 주소가 기준이고, 검색어는 개인정보(이름·휴대폰)일 수 있어
// 개인정보 열람 권한이 있으면 주소에 넣지 않고 history state에, 없으면(닉네임뿐) 주소(?q=)에 둔다. 상세 → Back에서 조건과 스크롤이 복원된다.
// 선택한 회원: 「선택 알림 발송」은 회원 알림 발송(SA-049) 새 발송을 「직접 선택」 대상으로 열고, 「선택 등급 조정」은 회원 1명씩 PUT /api/seller/member-grades/members/{id}를 부른다.
const PAGE = 10;
const PICK_MAX = 200; // 서버 직접 선택 대상 상한(shop-member-messages PICK_MAX)과 같은 값
const PICKED_KEY = "member-messages-picked";
type Page = { members: MemberRow[]; nextCursor: string | null };
type Row = Page["members"][number];
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: Row[]; next: string | null };
type Summary = { total: number; newThisMonth: number; purchasedThisMonth: number; gold: number; vip: number; restricted: number; marketingConsent: number };
type Grade = { id: string; displayName: string };
type Applied = { q: string; qType: string; gradeIds: string; status: string; joinedFrom: string; joinedTo: string; lastOrder: string; marketing: string; hasBalance: string; hasMemo: string; sort: string };

const QUERY_DEFAULTS = { qType: "nickname", gradeIds: "", status: "", joinedFrom: "", joinedTo: "", lastOrder: "", marketing: "", hasBalance: "", hasMemo: "", sort: "lastOrder", q: "" };
const Q_TYPES = [
  { v: "nickname", label: "닉네임" },
  { v: "name", label: "이름" },
  { v: "phoneLast4", label: "휴대폰 뒷자리" },
];
const STATUSES = [
  { v: "", label: "전체" },
  { v: "NORMAL", label: "정상" },
  { v: "RESTRICTED", label: "구매 제한" },
];
const LAST_ORDERS = [
  { v: "", label: "전체" },
  { v: "30d", label: "30일 안" },
  { v: "90d", label: "90일 안" },
  { v: "over90d", label: "90일 넘게 없음" },
];
const SORTS = [
  { v: "lastOrder", label: "최근 주문순" },
  { v: "joined", label: "가입일순" },
  { v: "spent", label: "누적 구매 많은순" },
  { v: "reward", label: "적립금 많은순" },
];

function query(f: Applied, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (f.q) {
    p.set("q", f.q);
    p.set("qType", f.qType);
  }
  if (f.gradeIds) p.set("gradeIds", f.gradeIds);
  if (f.status) p.set("status", f.status);
  if (f.joinedFrom) p.set("joinedFrom", f.joinedFrom);
  if (f.joinedTo) p.set("joinedTo", f.joinedTo);
  if (f.lastOrder) p.set("lastOrder", f.lastOrder);
  if (f.marketing) p.set("marketing", "true");
  if (f.hasBalance) p.set("hasBalance", "true");
  if (f.hasMemo) p.set("hasMemo", "true");
  p.set("sort", f.sort);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

// 개인정보일 수 있는 검색어를 담는 history state 칸. Next가 쓰는 값은 그대로 두고 이 칸만 더한다
const STATE_KEY = "memberSearch";
const readState = (): string => {
  const v = (window.history.state as Record<string, unknown> | null)?.[STATE_KEY];
  return typeof v === "string" ? v : "";
};
const writeState = (q: string) => {
  window.history.replaceState({ ...(window.history.state as object | null), [STATE_KEY]: q }, "");
};

export default function MemberListPage() {
  const router = useRouter();
  const { can, me } = useSeller();
  const piiSearch = can("CUSTOMER_PII_VIEW");
  const [u, setU] = useUrlState(QUERY_DEFAULTS);
  // 검색어: 개인정보 열람 권한이 있으면 history state(주소에 남기지 않음), 없으면 주소 쿼리
  const [stateQ, setStateQ] = useState("");
  // 처음 그릴 때(서버 렌더 뒤) history state의 검색어를 읽은 다음에 조회한다(조건 없이 한 번 받았다 다시 받지 않게)
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (piiSearch) setStateQ(readState());
    setRestored(true);
  }, [piiSearch]);
  const q = piiSearch ? stateQ : u.q;
  // 필터를 바꾸면 Next가 history 항목을 새 값으로 바꿔 검색어 칸이 지워지므로, 주소가 바뀔 때마다 다시 적어 둔다
  const urlKey = [u.qType, u.gradeIds, u.status, u.joinedFrom, u.joinedTo, u.lastOrder, u.marketing, u.hasBalance, u.hasMemo, u.sort].join("|");
  useEffect(() => {
    if (piiSearch && restored && readState() !== stateQ) writeState(stateQ);
  }, [piiSearch, restored, stateQ, urlKey]);
  const applied: Applied = { q, qType: u.qType, gradeIds: u.gradeIds, status: u.status, joinedFrom: u.joinedFrom, joinedTo: u.joinedTo, lastOrder: u.lastOrder, marketing: u.marketing, hasBalance: u.hasBalance, hasMemo: u.hasMemo, sort: u.sort };

  // 검색 상자의 입력(「검색」을 누르면 적용). Back·초기화로 적용 조건이 바뀌면 입력도 맞춘다
  const [draft, setDraft] = useState<Applied>(applied);
  const appliedKey = JSON.stringify(applied);
  useEffect(() => setDraft(JSON.parse(appliedKey) as Applied), [appliedKey]);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [grades, setGrades] = useState<Grade[]>([]);
  // 선택한 회원(쪽을 넘겨도 유지, 조건을 바꾸면 비움)
  const [picked, setPicked] = useState<Map<string, { nickname: string; grade: string; gradeId: string }>>(new Map());
  const [adjust, setAdjust] = useState<{ gradeId: string; lock: boolean; until: string; reason: string; busy: boolean; error: string } | null>(null);
  // 엑셀 내려받기(대표자만, 정본 「엑셀 내려받기 · 사유」): 사유(1~100자)를 고른 뒤 이름·연락처가 담긴 CSV를 내려받는다. 사유와 받은 사실은 로그 추적에 남는다
  const [exporting, setExporting] = useState<{ reason: string; custom: string; busy: boolean; error: string } | null>(null);

  useEffect(() => {
    void api<{ summary: Summary }>("/api/seller/members/summary").then((r) => r.ok && setSummary(r.data.summary));
    void api<{ grades: Grade[] }>("/api/seller/member-grades").then((r) => r.ok && setGrades(r.data.grades));
  }, []);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Applied) => {
    const id = ++reqId.current;
    // 조건을 바꾸면 방문한 커서와 현재 쪽을 초기화한다
    setPage(1); setCursors([undefined]); paging.current = false;
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/members?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.members, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    if (restored) {
      void load(JSON.parse(appliedKey) as Applied);
      setPicked(new Map());
    }
  }, [appliedKey, load, restored]);
  useScrollRestore("seller-members", state.kind === "ok");

  const turnPage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true; const id = ++reqId.current;
    const r = await api<Page>("/api/seller/members?" + query(applied, cursor ?? undefined));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast({ text: "불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    setState({ kind: "ok", items: r.data.members, next: r.data.nextCursor });
    setPage(target); setCursors(c => {
      const visited = target > c.length ? [...c, cursor ?? undefined] : c;
      return visited[target] && visited[target] !== r.data.nextCursor ? visited.slice(0, target) : visited;
    });
  };

  const applyDraft = () => {
    const next = { ...draft, q: draft.q.trim() };
    if (piiSearch) {
      writeState(next.q);
      setStateQ(next.q);
      setU({ qType: next.qType, gradeIds: next.gradeIds, status: next.status, joinedFrom: next.joinedFrom, joinedTo: next.joinedTo, lastOrder: next.lastOrder, marketing: next.marketing, hasBalance: next.hasBalance, hasMemo: next.hasMemo });
    } else setU({ q: next.q, qType: "nickname", gradeIds: next.gradeIds, status: next.status, joinedFrom: next.joinedFrom, joinedTo: next.joinedTo, lastOrder: next.lastOrder, marketing: next.marketing, hasBalance: next.hasBalance, hasMemo: next.hasMemo });
  };
  const resetFilters = () => {
    if (piiSearch) {
      writeState("");
      setStateQ("");
      setU({ ...QUERY_DEFAULTS, q: "", sort: u.sort });
    } else setU({ ...QUERY_DEFAULTS, sort: u.sort });
  };

  const exportReason = exporting ? (exporting.reason === "직접 입력" ? exporting.custom.trim() : exporting.reason) : "";
  const downloadMembers = async () => {
    if (!exporting || exporting.busy || !exportReason) return;
    setExporting({ ...exporting, busy: true, error: "" });
    const r = await apiDownload("/api/seller/bulk-io/members/export", { method: "POST", body: { reason: exportReason, includePii: true } });
    if (!r.ok) return setExporting((x) => (x ? { ...x, busy: false, error: r.message ?? "내려받지 못했습니다. 잠시 뒤 다시 시도해 주십시오" } : x));
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "members.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 내려받기가 시작된 뒤에 주소를 거둔다(바로 거두면 파일 이름이 사라진다)
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setExporting(null);
  };

  const items = state.kind === "ok" ? state.items : [];
  const filtered = applied.q !== "" || applied.gradeIds !== "" || applied.status !== "" || applied.joinedFrom !== "" || applied.joinedTo !== "" || applied.lastOrder !== "" || applied.marketing !== "" || applied.hasBalance !== "" || applied.hasMemo !== "";
  const showPii = items.some((m) => m.name !== undefined || m.phone !== undefined);
  const allPicked = items.length > 0 && items.every((m) => picked.has(m.id));
  const togglePick = (m: Row) =>
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(m.id)) next.delete(m.id);
      else if (next.size < PICK_MAX) next.set(m.id, { nickname: m.broadcastNickname ?? "닉네임 없음", grade: m.grade?.displayName ?? "-", gradeId: m.grade?.id ?? "" });
      return next;
    });
  const togglePage = () =>
    setPicked((cur) => {
      const next = new Map(cur);
      if (allPicked) for (const m of items) next.delete(m.id);
      else for (const m of items) if (next.size < PICK_MAX) next.set(m.id, { nickname: m.broadcastNickname ?? "닉네임 없음", grade: m.grade?.displayName ?? "-", gradeId: m.grade?.id ?? "" });
      return next;
    });
  const gradeChecked = (id: string) => draft.gradeIds.split(",").filter(Boolean).includes(id);
  const toggleGrade = (id: string) => {
    const cur = draft.gradeIds.split(",").filter(Boolean);
    setDraft({ ...draft, gradeIds: (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]).join(",") });
  };

  // 선택 알림 발송: 선택한 회원을 보관한 채 회원 알림 발송(SA-049)의 새 발송을 「직접 선택」으로 연다
  const sendToPicked = () => {
    if (picked.size === 0) return;
    try {
      sessionStorage.setItem(PICKED_KEY, JSON.stringify([...picked].map(([id, v]) => ({ id, broadcastNickname: v.nickname }))));
    } catch {
      return setToast({ text: "선택한 회원을 넘기지 못했습니다. 다시 눌러 주십시오", neg: true });
    }
    router.push("/seller/member-messages?section=new&picked=1");
  };
  const submitAdjust = async () => {
    if (!adjust || adjust.busy || !adjust.gradeId) return;
    setAdjust({ ...adjust, busy: true, error: "" });
    let done = 0;
    const failed: string[] = [];
    for (const [id, v] of picked) {
      const r = await api(`/api/seller/member-grades/members/${id}`, {
        method: "PUT",
        body: { gradeId: adjust.gradeId, lock: adjust.lock, ...(adjust.lock && adjust.until ? { until: adjust.until } : {}), ...(adjust.lock && adjust.reason.trim() ? { reason: adjust.reason.trim() } : {}) },
      });
      if (r.ok) done++;
      else failed.push(v.nickname);
    }
    if (failed.length > 0) {
      setAdjust({ ...adjust, busy: false, error: `${done}명은 조정했고 ${failed.length}명은 조정하지 못했습니다(${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " 외" : ""}). 활동 중인 회원만 조정할 수 있습니다` });
      void load(applied);
      return;
    }
    setAdjust(null);
    setPicked(new Map());
    setToast({ text: `${done}명의 등급을 조정했습니다` });
    void load(applied);
  };
  const searchHint = "검색어 입력";
  const emptyText = filtered ? (applied.q && applied.qType === "phoneLast4" ? `「${applied.q}」 뒷자리와 일치하는 회원이 없습니다` : "조건에 맞는 회원이 없습니다") : "아직 가입한 회원이 없습니다. 쇼핑몰 주소를 방송에서 공유해 주십시오";

  return (
    <>
      <Topbar crumb="고객 › 회원 목록 › 회원" />
      <main className="main">
        <PageHead
          title="회원"
          actions={
            <>
              <Link className="btn btn-out" href="/seller/member-grades">
                회원 등급
              </Link>
              <Link className="btn btn-out" href="/seller/purchase-restrictions">
                구매 제한
              </Link>
            </>
          }
        />

        <section className="card mb-sum" aria-label="요약">
          <div>
            <span className="t-l2 c-alt">전체 회원</span>
            <b className="num">{summary ? `${summary.total.toLocaleString("ko-KR")}명` : "—"}</b>
          </div>
          <div>
            <span className="t-l2 c-alt">이번 달 신규</span>
            <b className="num">{summary ? `${summary.newThisMonth.toLocaleString("ko-KR")}명` : "—"}</b>
          </div>
          <div>
            <span className="t-l2 c-alt">이번 달 구매 회원</span>
            <b className="num">{summary ? `${summary.purchasedThisMonth.toLocaleString("ko-KR")}명` : "—"}</b>
          </div>
          <div>
            <span className="t-l2 c-alt">골드 · VIP</span>
            <b className="num">{summary ? `${summary.gold.toLocaleString("ko-KR")} / ${summary.vip.toLocaleString("ko-KR")}` : "—"}</b>
          </div>
          <div>
            <span className="t-l2 c-alt">구매 제한</span>
            <b className="num">{summary ? `${summary.restricted.toLocaleString("ko-KR")}명` : "—"}</b>
          </div>
          <div>
            <span className="t-l2 c-alt">혜택 · 소식 동의</span>
            <b className="num">{summary ? `${summary.marketingConsent.toLocaleString("ko-KR")}명` : "—"}</b>
          </div>
        </section>

        <SearchBox onSearch={applyDraft} onReset={resetFilters} busy={state.kind === "loading"}>
          <SearchRow label="검색어">
            {piiSearch ? (
              <select className="inp" aria-label="검색 대상" value={draft.qType} onChange={(e) => setDraft({ ...draft, qType: e.target.value })}>
                {Q_TYPES.map((t) => (
                  <option key={t.v} value={t.v}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : null}
            <input
              className="inp"
              type="search"
              placeholder={searchHint}
              aria-label="회원 검색"
              value={draft.q}
              maxLength={MAX_SEARCH_LENGTH}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </SearchRow>
          <SearchRow
            label="등급"
            label2="상태"
            children2={STATUSES.map((s) => (
              <label key={s.v} className="chk">
                <input className="rdo" type="radio" name="mb-status" checked={draft.status === s.v} onChange={() => setDraft({ ...draft, status: s.v })} />
                {s.label}
              </label>
            ))}
          >
            <label className="chk">
              <input className="cbx" type="checkbox" checked={draft.gradeIds === ""} onChange={() => setDraft({ ...draft, gradeIds: "" })} />
              전체
            </label>
            {[...grades].reverse().map((g) => (
              <label key={g.id} className="chk">
                <input className="cbx" type="checkbox" checked={gradeChecked(g.id)} onChange={() => toggleGrade(g.id)} />
                {g.displayName}
              </label>
            ))}
          </SearchRow>
          <SearchRow
            label="가입일"
            label2="최근 주문"
            children2={
              <select className="inp" aria-label="최근 주문" value={draft.lastOrder} onChange={(e) => setDraft({ ...draft, lastOrder: e.target.value })}>
                {LAST_ORDERS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            }
          >
            <DateRangePicker fromLabel="가입 시작일" toLabel="가입 종료일" from={draft.joinedFrom} to={draft.joinedTo} onChange={(r) => setDraft({ ...draft, joinedFrom: r.from, joinedTo: r.to })} quick />
          </SearchRow>
          <SearchRow label="기타">
            <label className="chk">
              <input className="cbx" type="checkbox" checked={draft.marketing !== ""} onChange={(e) => setDraft({ ...draft, marketing: e.target.checked ? "1" : "" })} />
              혜택 · 소식 동의
            </label>
            <label className="chk">
              <input className="cbx" type="checkbox" checked={draft.hasBalance !== ""} onChange={(e) => setDraft({ ...draft, hasBalance: e.target.checked ? "1" : "" })} />
              적립금 잔액 있음
            </label>
            <label className="chk">
              <input className="cbx" type="checkbox" checked={draft.hasMemo !== ""} onChange={(e) => setDraft({ ...draft, hasMemo: e.target.checked ? "1" : "" })} />
              메모 있음
            </label>
          </SearchRow>
        </SearchBox>

        <section className="au-list-section">
          <div className="mb-bar">
            <span className="row" style={{ gap: 8 }}>
              <span className="t-l2" data-testid="member-count" style={{ whiteSpace: "nowrap" }}>
                {state.kind === "ok" ? `현재 ${items.length}명` : ""}
              </span>
              <select className="inp" aria-label="정렬" value={u.sort} onChange={(e) => setU({ sort: e.target.value })}>
                {SORTS.map((s) => (
                  <option key={s.v} value={s.v}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select className="inp" aria-label="표시 개수" value={String(PAGE)} onChange={() => undefined}>
                <option value={String(PAGE)}>{PAGE}개씩</option>
              </select>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-out" type="button" disabled={picked.size === 0} onClick={sendToPicked}>
                선택 알림 발송
              </button>
              <button className="btn btn-sm btn-out" type="button" disabled={picked.size === 0} onClick={() => setAdjust({ gradeId: "", lock: false, until: "", reason: "", busy: false, error: "" })}>
                선택 등급 조정
              </button>
              {me.isOwner && (
                <button className="btn btn-sm btn-out" type="button" onClick={() => setExporting({ reason: "", custom: "", busy: false, error: "" })}>
                  엑셀 내려받기 (대표자)
                </button>
              )}
            </span>
          </div>

          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : <div className="card"><ErrorState title="회원 목록을 불러오지 못했습니다" onRetry={() => void load(applied)} /></div>)}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{emptyText}</span>
                {filtered && (
                  <button className="btn btn-sm btn-out" type="button" onClick={resetFilters}>
                    초기화
                  </button>
                )}
              </div>
            ) : (
              <>
                <ListTable>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>
                          <input className="cbx" type="checkbox" aria-label="이 쪽 전체 선택" checked={allPicked} onChange={togglePage} />
                        </th>
                        <th>회원</th>
                        <th>번호</th>
                        <th>등급</th>
                        <th>가입일</th>
                        <th>주문</th>
                        <th>누적 구매</th>
                        <th>적립금</th>
                        <th>최근 주문</th>
                        <th>상태</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((m) => (
                        <tr key={m.id} data-testid="member-row">
                          <td>
                            <input className="cbx" type="checkbox" aria-label={`${m.broadcastNickname ?? "닉네임 없음"} 선택`} checked={picked.has(m.id)} onChange={() => togglePick(m)} />
                          </td>
                          <td>
                            <span className="col" style={{ gap: 2 }}>
                              <Link className="fw6" href={`/seller/members/${m.id}`}>
                                {m.broadcastNickname ?? "닉네임 없음"}
                              </Link>
                              {showPii && (
                                <span className="t-c1 c-alt">
                                  {m.name ?? "-"}
                                  {m.phone ? ` · ${phoneText(m.phone)}` : ""}
                                </span>
                              )}
                            </span>
                          </td>
                          <td className="num">{m.number ?? "-"}</td>
                          <td>{m.grade?.displayName ?? "-"}</td>
                          <td className="num">{formatDate(m.createdAt)}</td>
                          <td className="num">{m.orderCount.toLocaleString("ko-KR")}</td>
                          <td className="num">{won(m.totalPaid)}</td>
                          <td className="num">{won(m.rewardBalance)}</td>
                          <td className="num">{m.lastOrderAt ? formatDateTime(m.lastOrderAt) : "-"}</td>
                          <td>
                            <span className={`bdg ${m.status === "DORMANT" ? "b-gray" : m.restricted ? "b-fail" : "b-done"}`}>{m.status === "DORMANT" ? "휴면" : m.restricted ? "구매 제한" : "정상"}</span>
                          </td>
                          <td>
                            <Link className="btn btn-sm btn-out" href={`/seller/members/${m.id}`}>
                              상세
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ListTable>
                {(page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={n => void turnPage(n)} onNext={() => void turnPage(page + 1)} />}
                <span className="t-c1 c-alt">이름 · 연락처 열람은 로그 추적에 남음 · 엑셀 내려받기(이름 · 연락처 포함)는 대표자만 · 사유 기록</span>
              </>
            ))}
        </section>
      </main>
      {adjust && (
        <Modal labelId="member-adjust-title" busy={adjust.busy} dirty={adjust.gradeId !== "" || adjust.lock || adjust.reason !== ""} onClose={() => setAdjust(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="member-adjust-title">
                  선택한 회원 {picked.size.toLocaleString("ko-KR")}명의 등급을 조정하시겠습니까?
                </h2>
              </div>
              <div className="col" style={{ gap: 12 }}>
                <p className="t-l2">
                  {[...picked.values()].slice(0, 3).map((v) => v.nickname).join(" · ")}
                  {picked.size > 3 ? ` 외 ${picked.size - 3}명` : ""}{" "}
                  <span className="c-alt">(지금 등급 {[...picked.values()].slice(0, 3).map((v) => v.grade).join(" · ")}{picked.size > 3 ? " …" : ""})</span>
                </p>
                <table className="au-ft">
                  <tbody>
                    <tr>
                      <th scope="row">
                        <label htmlFor="mb-adj-grade" className="req">
                          등급
                        </label>
                      </th>
                      <td>
                        <div className="au-ft-v">
                          <select id="mb-adj-grade" className="inp" value={adjust.gradeId} disabled={adjust.busy} onChange={(e) => setAdjust({ ...adjust, gradeId: e.target.value })}>
                            <option value="">등급 선택</option>
                            {grades.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.displayName}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">자동 재산정</th>
                      <td>
                        <div className="au-ft-v">
                          <label className="chk">
                            <input className="cbx" type="checkbox" checked={adjust.lock} disabled={adjust.busy} onChange={(e) => setAdjust({ ...adjust, lock: e.target.checked })} />
                            자동 재산정에서 제외(고정)
                          </label>
                        </div>
                        <p className="help au-ft-help">고정하면 재산정 때 건너뜁니다 · 종료일이 없으면 직접 풀 때까지 고정됩니다</p>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">
                        <label htmlFor="mb-adj-until">고정 종료일</label>
                      </th>
                      <td>
                        <div className="au-ft-v">
                          <DatePicker id="mb-adj-until" value={adjust.until} disabled={!adjust.lock || adjust.busy} onChange={(v) => setAdjust({ ...adjust, until: v })} />
                        </div>
                        <p className="help au-ft-help">비우면 직접 풀 때까지 · 지나면 다음 재산정부터 기준을 적용합니다</p>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">
                        <label htmlFor="mb-adj-reason">사유</label>
                      </th>
                      <td>
                        <div className="au-ft-v">
                          <input id="mb-adj-reason" className="inp" placeholder="사유 입력" maxLength={100} value={adjust.reason} disabled={!adjust.lock || adjust.busy} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
                        </div>
                        <p className="help au-ft-help">100자까지 · 로그 추적에 남습니다</p>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {adjust.error && (
                  <div className="msg msg-neg" role="alert">
                    <span>{adjust.error}</span>
                  </div>
                )}
              </div>
              <div className="modal-f">
                <button className="btn btn-out" type="button" disabled={adjust.busy} onClick={requestClose}>
                  취소
                </button>
                <button className="btn" type="button" disabled={!adjust.gradeId || adjust.busy} onClick={() => void submitAdjust()}>
                  {adjust.busy ? "조정 중" : "등급 조정"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {exporting && (
        <Modal labelId="member-export-title" busy={exporting.busy} dirty={exporting.reason !== "" || exporting.custom !== ""} onClose={() => setExporting(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="member-export-title">
                  엑셀 내려받기
                </h2>
              </div>
              <div className="col" style={{ gap: 12 }}>
                <select className="inp" aria-label="내보내는 사유" value={exporting.reason} onChange={(e) => setExporting({ ...exporting, reason: e.target.value })}>
                  <option value="">내보내는 사유 선택</option>
                  <option value="적립금 소멸 안내">적립금 소멸 안내</option>
                  <option value="세무 · 회계 자료">세무 · 회계 자료</option>
                  <option value="직접 입력">직접 입력</option>
                </select>
                {exporting.reason === "직접 입력" && (
                  <input className="inp" aria-label="사유 직접 입력" placeholder="사유 입력" maxLength={100} value={exporting.custom} onChange={(e) => setExporting({ ...exporting, custom: e.target.value })} />
                )}
                <div className="msg msg-cau" role="note">
                  <span>개인정보가 담긴 파일입니다 · 사용 뒤 삭제 · 내려받은 사실과 사유는 로그 추적에 남습니다</span>
                </div>
                {exporting.error && (
                  <div className="msg msg-neg" role="alert">
                    <span>{exporting.error}</span>
                  </div>
                )}
              </div>
              <div className="modal-f">
                <button className="btn btn-out" type="button" onClick={requestClose}>
                  취소
                </button>
                <button className="btn" type="button" disabled={!exportReason || exporting.busy} onClick={() => void downloadMembers()}>
                  {exporting.busy ? "내려받는 중" : "내려받기"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {toast && <Toast text={toast.text} onDone={() => setToast(null)} neg={toast.neg} />}
    </>
  );
}
