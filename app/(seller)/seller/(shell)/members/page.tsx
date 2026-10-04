"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { MAX_SEARCH_LENGTH } from "../../../../../components/seller/format";
import { MEMBER_STATUS, memberDay, phoneText, type MemberRow, type MemberStatus } from "../../../../../components/seller/members/types";

// SA-041 회원 목록·검색(GET /api/seller/members, 회원·적립금 권한). 50명씩 이어서 불러온다.
// 검색은 방송 닉네임, 개인정보 열람 권한이 있으면 이름·휴대폰 끝 4자리도 찾는다(서버가 권한에 따라 정함).
const PAGE = 50;
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

export default function MemberListPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [search]);
  const [status, setStatus] = useState<MemberStatus | null>(null);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    // 조건을 바꾸면 이전 조건의 「더 보기」는 버려지므로 그 진행 표시도 거둔다
    setMore(false);
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/members?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.members, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load({ q, status }), [q, status, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await api<Page>(`/api/seller/members?${query({ q, status }, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.members], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오");
  };

  // 이름·휴대폰 끝자리 검색은 개인정보 열람 권한이 있을 때만 서버가 찾는다
  const { can } = useSeller();
  const searchHint = can("CUSTOMER_PII_VIEW") ? "닉네임 · 이름 · 휴대폰 끝자리" : "방송 닉네임";
  const items = state.kind === "ok" ? state.items : [];
  const filtered = q !== "" || status !== null;
  const showPii = items.some((m) => m.name !== undefined || m.phone !== undefined);

  return (
    <>
      <Topbar crumb="판매 › 회원" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">회원</h1>
            <span className="t-l2 c-alt">내 쇼핑몰에 가입한 구매자입니다. 탈퇴한 회원은 표시되지 않습니다.</span>
          </div>
        </div>

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
                      setQ("");
                      setStatus(null);
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
                <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                  <span className="t-c1 c-alt">{state.next ? `${items.length}명 넘게` : `${items.length}명`}</span>
                  {state.next && (
                    <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                      {more ? "불러오는 중" : "더 보기"}
                    </button>
                  )}
                </div>
              </>
            ))}
        </div>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} neg />}
    </>
  );
}
