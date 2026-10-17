"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CursorPagination, Modal, PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, apiDownload } from "../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { MAX_SEARCH_LENGTH } from "../../../../../components/seller/format";
import { MEMBER_STATUS, memberDay, phoneText, type MemberRow, type MemberStatus } from "../../../../../components/seller/members/types";

// SA-041 회원 목록·검색(GET /api/seller/members, 회원·적립금 권한). 현재 10명씩 커서로 조회한다.
// 검색은 방송 닉네임, 개인정보 열람 권한이 있으면 이름·휴대폰 끝 4자리도 찾는다(서버가 권한에 따라 정함).
// 상태 보존(IA Back 규칙 3항, UX 감사): 상태 필터는 주소(?status=)가 기준이고, 검색어는 개인정보(이름·휴대폰)일 수 있어
// 개인정보 열람 권한이 있으면 주소에 넣지 않고 history state에, 없으면(닉네임뿐) 주소(?q=)에 둔다. 상세 → Back에서 조건과 스크롤이 복원된다.
const PAGE = 10;
const SEARCH_DELAY_MS = 300;
type Page = { members: MemberRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: MemberRow[]; next: string | null };
type Filters = { q: string; status: MemberStatus | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (f.q) p.set("q", f.q);
  if (f.status) p.set("status", f.status);
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
  const { can, me } = useSeller();
  const piiSearch = can("CUSTOMER_PII_VIEW");
  const [u, setU] = useUrlState({ q: "", status: "" });
  const status: MemberStatus | null = u.status === "ACTIVE" || u.status === "DORMANT" ? u.status : null;
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
  useEffect(() => {
    if (piiSearch && restored && readState() !== stateQ) writeState(stateQ);
  }, [piiSearch, restored, stateQ, u.status]);
  const [search, setSearch] = useState(q);
  const setUrl = useRef(setU);
  setUrl.current = setU;
  useEffect(() => {
    const t = setTimeout(() => {
      const next = search.trim();
      if (piiSearch) {
        writeState(next);
        setStateQ(next);
      } else setUrl.current({ q: next });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [search, piiSearch]);
  // Back·조건 초기화로 조건이 바뀌면 입력 칸도 맞춘다. 입력 중인 글자는 건드리지 않는다
  useEffect(() => {
    setSearch((cur) => (cur.trim() === q ? cur : q));
  }, [q]);
  const setStatus = (v: MemberStatus | null) => setU({ status: v ?? "" });
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  // 엑셀 내려받기(대표자만, 정본 「엑셀 내려받기 · 사유」): 사유(1~100자)를 고른 뒤 이름·연락처가 담긴 CSV를 내려받는다. 사유와 받은 사실은 로그 추적에 남는다
  const [exporting, setExporting] = useState<{ reason: string; custom: string; busy: boolean; error: string } | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    // 조건을 바꾸면 방문한 커서와 현재 쪽을 초기화한다
    setPage(1); setCursors([undefined]); paging.current = false;
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/members?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.members, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    if (restored) void load({ q, status });
  }, [q, status, load, restored]);
  useScrollRestore("seller-members", state.kind === "ok");

  const turnPage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true; const id = ++reqId.current;
    const r = await api<Page>("/api/seller/members?" + query({ q, status }, cursor ?? undefined));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast("불러오지 못했습니다. 다시 눌러 주십시오");
    setState({ kind: "ok", items: r.data.members, next: r.data.nextCursor });
    setPage(target); setCursors(c => {
      const visited = target > c.length ? [...c, cursor ?? undefined] : c;
      return visited[target] && visited[target] !== r.data.nextCursor ? visited.slice(0, target) : visited;
    });
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

  // 이름·휴대폰 끝자리 검색은 개인정보 열람 권한이 있을 때만 서버가 찾는다
  const searchHint = can("CUSTOMER_PII_VIEW") ? "닉네임 · 이름 · 휴대폰 끝자리" : "방송 닉네임";
  const items = state.kind === "ok" ? state.items : [];
  const filtered = q !== "" || status !== null;
  const showPii = items.some((m) => m.name !== undefined || m.phone !== undefined);

  return (
    <>
      <Topbar crumb="판매 › 회원" />
      <main className="main">
        <PageHead title="회원" />

        <div className="card">
          <div className="toolbar" style={{ padding: 16 }}>
            <div className="search" style={{ flex: "1 1 220px" }}>
              <input
                className="inp inp-sm"
                type="search"
                placeholder={searchHint}
                aria-label="회원 검색"
                value={search}
                maxLength={MAX_SEARCH_LENGTH}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {(["ACTIVE", "DORMANT"] as const).map((s) => (
              <button key={s} type="button" className={`chip${status === s ? " on" : ""}`} aria-pressed={status === s} onClick={() => setStatus(status === s ? null : s)}>
                {MEMBER_STATUS[s].label}
                {status === s && <span className="x">×</span>}
              </button>
            ))}
            {me.isOwner && (
              <button className="btn btn-sm btn-out" type="button" style={{ marginLeft: "auto" }} onClick={() => setExporting({ reason: "", custom: "", busy: false, error: "" })}>
                엑셀 내려받기 (대표자)
              </button>
            )}
          </div>

          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="회원·적립금" /> : <ErrorState title="회원 목록을 불러오지 못했습니다" onRetry={() => void load({ q, status })} />)}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "조건에 맞는 회원이 없습니다" : "아직 가입한 회원이 없습니다"}</span>
                {filtered && (
                  <button
                    className="btn btn-sm btn-out"
                    type="button"
                    onClick={() => {
                      setSearch("");
                      if (piiSearch) {
                        writeState("");
                        setStateQ("");
                        setU({ status: "" });
                      } else setU({ q: "", status: "" });
                    }}
                  >
                    조건 초기화
                  </button>
                )}
              </div>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                    <thead>
                      <tr>
                        <th>방송 닉네임</th>
                        {showPii && <th>이름 · 휴대폰</th>}
                        <th>등급</th>
                        <th>상태</th>
                        <th>가입일</th>
                        <th>최근 로그인</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((m) => (
                        <tr key={m.id} data-testid="member-row">
                          <td>
                            <Link className="fw6" href={`/seller/members/${m.id}`}>
                              {m.broadcastNickname ?? "닉네임 없음"}
                            </Link>
                          </td>
                          {showPii && (
                            <td>
                              {m.name ?? "-"}
                              {m.phone ? <span className="c-alt"> · {phoneText(m.phone)}</span> : null}
                            </td>
                          )}
                          <td>{m.grade?.displayName ?? "-"}</td>
                          <td>
                            <span className={`bdg ${MEMBER_STATUS[m.status].cls}`}>{MEMBER_STATUS[m.status].label}</span>
                          </td>
                          <td className="num">{memberDay(m.createdAt)}</td>
                          <td className="num">{memberDay(m.lastLoginAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <span className="t-c1 c-alt">현재 {items.length}명</span>
                {(page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={n => void turnPage(n)} onNext={() => void turnPage(page + 1)} />}
              </>
            ))}
        </div>
      </main>
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
      {toast && <Toast text={toast} onDone={() => setToast(null)} neg />}
    </>
  );
}
