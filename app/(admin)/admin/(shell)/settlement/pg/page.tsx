"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { SELLER_STATUS, dayTime, type SellerStatus } from "../../../_components/partners";
import { useListFilters } from "../../../_components/useListFilters";

// MA-031 PG 연결 상태(GET /api/admin/pg-status, 모든 마스터 역할, 조회만). 키 값은 받지 않고 설정 여부만 본다.
// 실패 문구(lastFailureMessage)는 서버가 준 그대로 보여 준다. 50건씩 이어서 불러온다.
type Result = { lastSuccessAt: string | null; lastFailureAt: string | null; lastFailureCode: string | null; lastFailureMessage: string | null };
type Gateway = Result & { provider: string; configured: boolean; mode: "sandbox" | "live" };
type SellerPg = Result & {
  seller: { id: string; slug: string; shopName: string; status: SellerStatus };
  failures24h: number;
  cancelsPending: number;
  cancelsFailed: number;
};
type Page = { gateway: Gateway; sellers: SellerPg[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; gateway: Gateway; items: SellerPg[]; next: string | null };

const PAGE = 50;
const qs = (q: string, cursor?: string) => {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
};

function PgStatusPageInner() {
  const { applied: url, draft: d, setDraft, apply } = useListFilters({ q: "" });
  const applied = url.q;
  const draft = d.q;
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const load = useCallback(async (q: string) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/pg-status?${qs(q)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", gateway: r.data.gateway, items: r.data.sellers, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  useScrollRestore("admin-pg", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/pg-status?${qs(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ ...state, items: [...state.items, ...r.data.sellers], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const g = state.kind === "ok" ? state.gateway : null;
  return (
    <>
      <AdminTopbar crumb="정산 › PG 연결 상태" />
      <main className="main">
        <PageHead title="PG 연결 상태" />
        <div className="col" style={{ gap: 20 }}>
          {g && (
            <div className="card pad" data-testid="pg-gateway">
              <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <b>나이스페이</b>
                <span className={`bdg ${g.configured ? "ok" : "neg"}`}>{g.configured ? "연결됨" : "연결 안 됨"}</span>
                <span className="bdg">{g.mode === "sandbox" ? "시험 모드" : "실결제"}</span>
              </div>
              {g.configured ? (
                <p className="t-l2 c-alt" style={{ marginTop: 8 }}>
                  마지막 성공 {dayTime(g.lastSuccessAt)} · 마지막 실패 {dayTime(g.lastFailureAt)}
                  {g.lastFailureMessage && ` (${g.lastFailureMessage})`}
                </p>
              ) : (
                <p className="t-l2 c-alt" style={{ marginTop: 8 }}>
                  결제사 연결 정보가 설정되어 있지 않습니다. <Link href="/admin/settings/policy">플랫폼 정책에서 확인</Link>해 주십시오.
                </p>
              )}
            </div>
          )}
          <SearchBox onSearch={() => apply({ q: draft.trim() })} onReset={() => apply({ q: "" })} busy={state.kind === "loading"}>
            <SearchRow label="파트너스">
              <input className="inp" aria-label="쇼핑몰 이름 또는 주소" placeholder="쇼핑몰 이름·주소" value={draft} onChange={(e) => setDraft({ q: e.target.value })} />
            </SearchRow>
          </SearchBox>
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="PG 연결 상태를 불러오지 못했습니다." onRetry={() => void load(applied)} />}
            {state.kind === "ok" &&
              (state.items.length === 0 ? (
                <div className="st">
                  <span className="t">결제 내역이 있는 파트너스 중 조건에 맞는 곳이 없습니다.</span>
                </div>
              ) : (
                <>
                  <ListHead total={state.items.length} loaded={state.next !== null} />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>파트너스</th>
                          <th>상태</th>
                          <th>마지막 성공</th>
                          <th>마지막 실패</th>
                          <th>실패 사유</th>
                          <th>24시간 실패</th>
                          <th>취소 대기</th>
                          <th>취소 실패</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.items.map((r) => (
                          <tr key={r.seller.id} data-testid="pg-row">
                            <td>
                              <b>{r.seller.shopName}</b>
                            </td>
                            <td>
                              <span className={`bdg ${SELLER_STATUS[r.seller.status].cls}`}>{SELLER_STATUS[r.seller.status].label}</span>
                            </td>
                            <td>{dayTime(r.lastSuccessAt)}</td>
                            <td>{dayTime(r.lastFailureAt)}</td>
                            <td className="col-text">{r.lastFailureMessage ?? "-"}</td>
                            <td>{r.failures24h}</td>
                            <td>{r.cancelsPending}</td>
                            <td>{r.cancelsFailed}</td>
                            <td>
                              <Link className="btn btn-sm btn-out" href={`/admin/billing/invoices?sellerId=${r.seller.id}`}>
                                결제 내역
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: "12px 16px" }}>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                        {more ? "불러오는 중" : "더 보기"}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}

export default function PgStatusPage() {
  return (
    <Suspense fallback={null}>
      <PgStatusPageInner />
    </Suspense>
  );
}
