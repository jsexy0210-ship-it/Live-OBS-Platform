"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { useListFilters } from "../../../_components/useListFilters";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { AdminTopbar } from "../../../_components/AdminShell";
import { day, dayTime, won } from "../../../_components/partners";
import { PAYMENT_KIND, PAYMENT_STATUS, planLabel, type PaymentKind, type PaymentRow, type PaymentStatus } from "../../../_components/payments";

// MA-024 청구·결제 내역(GET /api/admin/payments, 모든 마스터 역할, 조회만). 상태·구분·청구 기간(KST 날짜) 필터, 파트너스 지정(?sellerId=).
// 50건씩 이어서 불러온다. 결제 실행·환불은 이 화면에 없다.
const PAGE = 50;
type Filters = { status: string; kind: string; from: string; to: string; sellerId: string };
type Page = { payments: PaymentRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: PaymentRow[]; next: string | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  for (const k of ["status", "kind", "from", "to", "sellerId"] as const) if (f[k]) p.set(k, f[k]);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

function Invoices() {
  const empty: Filters = { status: "", kind: "", from: "", to: "", sellerId: "" };
  const { applied, draft, setDraft, apply } = useListFilters<Filters>(empty);
  const [rangeError, setRangeError] = useState(false);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/payments?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.payments, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied), [applied, load]);
  useScrollRestore("admin-invoices", state.kind === "ok");

  const search = () => {
    if (draft.from && draft.to && draft.from > draft.to) return setRangeError(true);
    setRangeError(false);
    apply(draft);
  };
  const reset = () => {
    setRangeError(false);
    apply({ ...empty, sellerId: applied.sellerId });
  };
  const clearSeller = () => {
    apply({ ...applied, sellerId: "" });
  };

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/payments?${query(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.payments], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const items = state.kind === "ok" ? state.items : [];
  const filtered = !!(applied.status || applied.kind || applied.from || applied.to || applied.sellerId);

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 청구·결제 내역" />
      <main className="main">
        <PageHead title="청구·결제 내역" />
        <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
          <SearchRow label="결제 상태">
            <select className="inp" aria-label="결제 상태" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
              <option value="">전체</option>
              {(Object.keys(PAYMENT_STATUS) as PaymentStatus[]).map((s) => (
                <option key={s} value={s}>
                  {PAYMENT_STATUS[s].label}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="구분">
            <select className="inp" aria-label="구분" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              <option value="">전체</option>
              {(Object.keys(PAYMENT_KIND) as PaymentKind[]).map((k) => (
                <option key={k} value={k}>
                  {PAYMENT_KIND[k]}
                </option>
              ))}
            </select>
          </SearchRow>
          <SearchRow label="청구 기간">
            <input className="inp" type="date" aria-label="청구 시작일" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <span aria-hidden="true">~</span>
            <input className="inp" type="date" aria-label="청구 종료일" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            {rangeError && (
              <span className="err" role="alert">
                시작일이 종료일보다 늦습니다.
              </span>
            )}
          </SearchRow>
        </SearchBox>
        {applied.sellerId && (
          <div className="row" style={{ gap: 8, margin: "8px 0" }}>
            <span className="t-l2 c-alt">한 파트너스의 내역만 보고 있습니다.</span>
            <button className="btn btn-sm btn-out" type="button" onClick={clearSeller}>
              전체 보기
            </button>
          </div>
        )}

        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="청구·결제 내역을 불러오지 못했습니다." onRetry={() => void load(applied)} />}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "조건에 맞는 내역이 없습니다." : "아직 청구·결제 내역이 없습니다."}</span>
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
                        <th>청구</th>
                        <th>파트너스</th>
                        <th>항목</th>
                        <th>금액</th>
                        <th>상태</th>
                        <th>이용 기간</th>
                        <th>결제일</th>
                        <th>관리</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((p) => (
                        <tr key={p.id} data-testid="payment-row">
                          <td className="num">
                            <Link className="fw6" href={`/admin/billing/invoices/${p.id}`}>
                              {dayTime(p.createdAt)}
                            </Link>
                          </td>
                          <td>
                            <Link className="fw6" href={`/admin/partners/${p.seller.id}`}>
                              {p.seller.shopName}
                            </Link>
                          </td>
                          <td>
                            {PAYMENT_KIND[p.kind]}
                            {p.kind === "PRORATION" && p.targetPlanCode ? <span className="c-alt"> · {planLabel(p.targetPlanCode)}</span> : null}
                          </td>
                          <td className="num">{won(p.amount)}</td>
                          <td>
                            <span className={`bdg ${PAYMENT_STATUS[p.status].cls}`}>{PAYMENT_STATUS[p.status].label}</span>
                          </td>
                          <td className="num">
                            {day(p.periodStart)} ~ {day(p.periodEnd)}
                          </td>
                          <td className="num">{dayTime(p.paidAt)}</td>
                          <td>
                            <Link className="btn btn-sm btn-out" href={`/admin/billing/invoices/${p.id}`}>
                              상세
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                  <span className="t-c1 c-alt">{state.next ? `${items.length}건 넘게` : `${items.length}건`}</span>
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
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={null}>
      <Invoices />
    </Suspense>
  );
}
