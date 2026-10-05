"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../lib/server/authz/permissions";
import { PageHead, SearchBox, SearchRow } from "../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../components/seller/States";
import { MAX_SEARCH_LENGTH } from "../../../../../components/seller/format";
import { adminApi } from "../../_components/api";
import { AdminTopbar, useAdmin } from "../../_components/AdminShell";
import { SELLER_STATUS, SUBSCRIPTION_STATUS, PLAN_FILTER, day, type SellerRow, type SellerStatus } from "../../_components/partners";
import { SuspendDialog } from "../../_components/SuspendDialog";
import { useListFilters } from "../../_components/useListFilters";
import { useScrollRestore } from "../../../../../lib/client/navigation";

// MA-011 파트너스 목록·검색·필터(GET /api/admin/sellers, 모든 마스터 역할). 50명씩 이어서 불러온다.
// 이용 정지·해제(MA-015)는 최고관리자·운영만 버튼이 보인다.
const PAGE = 50;
type Filters = { q: string; status: string; plan: string };
const EMPTY: Filters = { q: "", status: "", plan: "" };
type Page = { sellers: SellerRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: SellerRow[]; next: string | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (f.q) p.set("q", f.q);
  if (f.status) p.set("status", f.status);
  if (f.plan) p.set("plan", f.plan);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

function PartnerList() {
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const { applied, draft, setDraft, apply } = useListFilters<Filters>(EMPTY);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [target, setTarget] = useState<SellerRow | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/sellers?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.sellers, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  useScrollRestore("admin-partners", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/sellers?${query(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.sellers], next: r.data.nextCursor });
    else setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오.", neg: true });
  };

  const done = (status: SellerStatus) => {
    if (!target) return;
    const id = target.id;
    setState((s) => (s.kind === "ok" ? { ...s, items: s.items.map((x) => (x.id === id ? { ...x, status } : x)) } : s));
    setTarget(null);
    setToast({ text: status === "SUSPENDED" ? "이용을 정지했습니다." : "정지를 해제했습니다." });
  };

  const items = state.kind === "ok" ? state.items : [];
  const filtered = applied.q !== "" || applied.status !== "" || applied.plan !== "";
  const reset = () => {
    apply(EMPTY);
  };

  return (
    <>
      <AdminTopbar crumb="파트너스 › 파트너스 목록" />
      <main className="main">
        <PageHead title="파트너스 목록" />
        <SearchBox onSearch={() => apply({ ...draft, q: draft.q.trim() })} onReset={reset} busy={state.kind === "loading"}>
          <SearchRow label="검색어">
            <input className="inp" type="search" aria-label="쇼핑몰 이름 · 주소" placeholder="쇼핑몰 이름 · 주소" maxLength={MAX_SEARCH_LENGTH} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </SearchRow>
          <SearchRow label="상태">
            <select className="inp" aria-label="상태" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="">전체</option>
              {(Object.keys(SELLER_STATUS) as SellerStatus[]).map((s) => (
                <option key={s} value={s}>
                  {SELLER_STATUS[s].label}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="요금제">
            <select className="inp" aria-label="요금제" value={draft.plan} onChange={(e) => setDraft({ ...draft, plan: e.target.value })}>
              <option value="">전체</option>
              {PLAN_FILTER.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          </SearchRow>
        </SearchBox>

        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="파트너스 목록을 불러오지 못했습니다." onRetry={() => void load(applied)} />}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "조건에 맞는 파트너스가 없습니다." : "아직 가입한 파트너스가 없습니다."}</span>
                {filtered && (
                  <button className="btn btn-sm btn-out" type="button" onClick={reset}>
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
                        <th>쇼핑몰</th>
                        <th>상태</th>
                        <th>요금제</th>
                        <th>구독</th>
                        <th>체험 종료</th>
                        <th>가입일</th>
                        <th>승인일</th>
                        {canModerate && <th>작업</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((s) => (
                        <tr key={s.id} data-testid="partner-row">
                          <td>
                            <Link className="fw6" href={`/admin/partners/${s.id}`}>
                              {s.shopName}
                            </Link>
                            <span className="c-alt"> · 쇼핑몰 주소 {s.slug}</span>
                          </td>
                          <td>
                            <span className={`bdg ${SELLER_STATUS[s.status].cls}`}>{SELLER_STATUS[s.status].label}</span>
                          </td>
                          <td>{s.plan?.name ?? "-"}</td>
                          <td>{s.subscription ? <span className={`bdg ${SUBSCRIPTION_STATUS[s.subscription.status].cls}`}>{SUBSCRIPTION_STATUS[s.subscription.status].label}</span> : "-"}</td>
                          <td className="num">{day(s.trialEndsAt)}</td>
                          <td className="num">{day(s.createdAt)}</td>
                          <td className="num">{day(s.approvedAt)}</td>
                          {canModerate && (
                            <td>
                              {(s.status === "ACTIVE" || s.status === "SUSPENDED") && (
                                <button className="btn btn-sm btn-out" type="button" onClick={() => setTarget(s)}>
                                  {s.status === "ACTIVE" ? "이용 정지" : "정지 해제"}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                  <span className="t-c1 c-alt">{state.next ? `${items.length}곳 넘게` : `${items.length}곳`}</span>
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
      {target && (
        <SuspendDialog
          seller={target}
          onClose={() => setTarget(null)}
          onDone={done}
          onStale={() => {
            setTarget(null);
            setToast({ text: "다른 곳에서 이미 처리됐습니다. 목록을 새로 불러옵니다.", neg: true });
            void load(applied);
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
