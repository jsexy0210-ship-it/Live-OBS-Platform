"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, useRef } from "react";
import { CursorPagination } from "../../../../../components/Pagination";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { formatDateTime } from "../../../../../lib/client/format";
import { StateBox, stateKind } from "../banners/_shared/ui";
import { type Data, type Tab, TABS, STATUS, KIND, REASON } from "../../../../../components/seller/ReturnOperations";
import "./returns.css";

export default function Page() { return <Suspense><ReturnsPage /></Suspense>; }

function ReturnsPage() {
  const { can, me } = useSeller();
  const router = useRouter();
  const params = useSearchParams();
  const listHref = `/seller/returns${params.size ? `?${params.toString()}` : ""}`;
  const canEdit = can("ORDER_SHIPPING") && !me.readOnly;
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; data: Data }>({ kind: "loading" });
  // 탭은 URL 쿼리(?status=REQUESTED 등)와 맞춘다: 파트너스 홈 「처리할 일」 링크가 접수 탭으로 바로 연다
  const [urlState, setUrlState] = useUrlState({ status: "all" });
  const tab: Tab = TABS.some((t) => t.key === urlState.status) ? (urlState.status as Tab) : "all";
  const setTab = (t: Tab) => setUrlState({ status: t });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const reqId = useRef(0);
  const paging = useRef(false);
  const initialPaging = useRef(true);
  const pagingScope = useRef("");
  const [toast, setToast] = useState<string | null>(null);

  const query = useCallback((cursor?: string) => `/api/seller/returns?${new URLSearchParams({ ...(tab !== "all" ? { status: tab } : {}), ...(cursor ? { cursor } : {}) })}`, [tab]);
  const load = useCallback(async () => {
    const id = ++reqId.current; paging.current = true;
    let scope = "";
    try { if (me.sellerId && me.userId) scope = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([me.sellerId, me.userId, tab])))), n => n.toString(16).padStart(2, "0")).join(""); } catch {}
    if (id !== reqId.current) return;
    pagingScope.current = scope;
    let restore: { page: number; cursors: (string | undefined)[] } | undefined;
    if (initialPaging.current && scope) {
      try { const stored = sessionStorage.getItem("onq:returns:return"); sessionStorage.removeItem("onq:returns:return"); const saved = JSON.parse(stored ?? "null"); if (saved?.scope === scope && Number.isInteger(saved.page) && saved.page >= 1 && Array.isArray(saved.cursors) && saved.cursors.length === saved.page && saved.cursors[0] === null && saved.cursors.slice(1).every((c: unknown) => typeof c === "string" && c.length > 0)) { restore = { page: saved.page, cursors: saved.cursors.map((c: string | null) => c ?? undefined) }; } } catch {}
    }
    initialPaging.current = false;
    const r = await api<Data>(query(restore?.cursors[restore.page - 1]));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", data: r.data }); setPage(restore?.page ?? 1); setCursors(restore?.cursors ?? [undefined]);
  }, [query, me.sellerId, me.userId]);
  const goPage = async (target: number, cursor = cursors[target - 1]) => {
    if (state.kind !== "ok" || paging.current || target < 1 || target > cursors.length + 1) return;
    paging.current = true;
    const id = reqId.current; const r = await api<Data>(query(cursor));
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setToast("목록을 불러오지 못했습니다. 다시 눌러 주십시오");
    setState({ kind: "ok", data: r.data });
    setCursors((prev) => [...prev.slice(0, target - 1), cursor]); setPage(target);
  };
  useEffect(() => {
    void load();
    return () => { reqId.current++; };
  }, [load]);

  useScrollRestore("seller-returns", state.kind === "ok");
  const data = state.kind === "ok" ? state.data : null;
  const rows = data?.returns ?? [];
  const c = data?.counts ?? {};

  return (
    <>
      <Topbar crumb="주문 › 교환 · 반품" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">교환 · 반품</h1>
            <span className="t-l2 c-alt">구매자가 신청한 교환·반품을 처리하는 화면입니다. 접수 → 수거 → 상품 확인 → 환불 또는 교환 상품 발송 순서로 진행합니다.</span>
          </div>
        </div>
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="교환 · 반품" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="교환 · 반품" onRetry={() => void load()} />}
          {data && (
            <>
              <div className="rt-sum" data-testid="rt-summary">
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">접수 (처리 필요)</span>
                  <b className="t-t3 num">{data.summary.requested}건</b>
                  <span className="t-c1 c-alt">24시간 안 승인 · 거절 권장</span>
                </div>
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">수거 · 확인 중</span>
                  <b className="t-t3 num">{data.summary.inProgress}건</b>
                </div>
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">이번 달 완료</span>
                  <b className="t-t3 num">{data.summary.doneReturn + data.summary.doneExchange}건</b>
                  <span className="t-c1 c-alt">
                    반품 {data.summary.doneReturn} · 교환 {data.summary.doneExchange}
                  </span>
                </div>
                <div className="rt-sum-c">
                  <span className="t-c1 c-alt">반품률 (30일)</span>
                  <b className="t-t3 num">{data.summary.returnRate30 === null ? "-" : `${data.summary.returnRate30}%`}</b>
                  <span className="t-c1 c-alt">반품 ÷ 배송 완료 주문</span>
                </div>
              </div>
              <div className="tabs" role="tablist" style={{ padding: "0 12px" }}>
                {TABS.map((t) => (
                  <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
                    {t.label}
                    {t.key === "REQUESTED" && <span className="cnt">{c.REQUESTED ?? 0}</span>}
                  </button>
                ))}
              </div>
              {rows.length === 0 ? (
                <div className="st" style={{ boxShadow: "none" }}>
                  <span className="t">{tab === "all" ? "처리할 교환 · 반품 요청이 없습니다" : "해당하는 신청이 없습니다"}</span>
                  <span className="s">구매자가 주문 상세에서 신청하면 여기에 들어옵니다</span>
                </div>
              ) : (
                <div role="list">
                  {rows.map((r) => (
                    <Link key={r.id} className="rt-row" role="listitem" data-testid="return-row" href={`/seller/returns/${r.id}?${new URLSearchParams({ returnTo: listHref })}`} onClick={async e => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); try { if (pagingScope.current) sessionStorage.setItem("onq:returns:return", JSON.stringify({ scope: pagingScope.current, page, cursors })); } catch {} router.push(`/seller/returns/${r.id}?${new URLSearchParams({ returnTo: listHref })}`); }}>
                      <span className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2 fw6 num">주문 {r.orderNo}</span>
                        <span className="t-c1 c-alt">{r.nickname}</span>
                      </span>
                      <span className="t-l2 fw6">{KIND[r.kind]}</span>
                      <span className="col rt-hide-m" style={{ gap: 2, minWidth: 0 }}>
                        <span className="t-l2">{REASON[r.reason]}</span>
                        <span className="t-c1 c-alt ell">
                          {r.items.map((i) => `${i.productName} ${i.quantity}개`).join(" · ")}
                        </span>
                      </span>
                      <span>
                        <span className={`bdg ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                      </span>
                      <span className="t-c1 c-alt rt-hide-m num">{formatDateTime(r.createdAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
        {data && (page > 1 || data.nextCursor) && <CursorPagination page={page} visited={cursors.length} hasNext={!!data.nextCursor} onChange={(target) => void goPage(target)} onNext={() => { if (data.nextCursor) void goPage(page + 1, data.nextCursor); }} />}
        {data && !canEdit && (
          <div className="msg msg-info" role="status">
            <span>신청 처리는 대표자나 주문 · 배송 권한이 있는 직원만 할 수 있습니다.</span>
          </div>
        )}
        {data && <span className="t-c1 c-alt">요청 가능 기간은 배송 완료 뒤 7일 안(불량 · 오배송은 기간과 상관없이 접수) · 개봉한 상품은 단순 변심으로 신청할 수 없음 · 처음 낸 배송비가 0원이면 반품 배송비를 왕복으로 뺍니다</span>}
        {data && <span className="t-c1 c-alt">승인 · 거절 · 상품 확인 · 환불 · 교환 발송은 로그 추적에 남음 · 진행 중인 신청이 있는 주문은 자동 구매 확정에서 제외</span>}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
