"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { MAX_SEARCH_LENGTH } from "../../../../../../components/seller/format";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { PLAN_FILTER, SUBSCRIPTION_STATUS, day, dayTime, type PlanRef, type SubscriptionStatus } from "../../../_components/partners";

// MA-023 구독 현황(GET /api/admin/subscriptions, 모든 마스터 역할, 조회만). 이용 상태별 탭과 쇼핑몰 이름·주소 검색, 요금제 필터.
// 탭은 서버의 이용 상태 5가지와 1:1이다(체험·이용 중·결제 처리 중·연체·해지). 숫자는 검색·요금제 필터 전 전체 수.
type Access = "trial" | "paid" | "charging" | "grace" | "expired";
const ACCESS: Record<Access, { label: string; cls: string }> = {
  trial: { label: "체험", cls: "b-info" },
  paid: { label: "이용 중", cls: "b-done" },
  charging: { label: "결제 진행 중", cls: "b-wait" },
  grace: { label: "연체", cls: "b-warn" },
  expired: { label: "해지", cls: "b-gray" },
};
const TABS: Access[] = ["trial", "paid", "charging", "grace", "expired"];
type Row = {
  seller: { id: string; slug: string; shopName: string; status: string };
  access: Access;
  plan: PlanRef | null;
  trialEndsAt: string | null;
  subscription: {
    status: SubscriptionStatus;
    cardLabel: string | null;
    currentPeriodEnd: string | null;
    nextChargeAt: string | null;
    cancelAtPeriodEnd: boolean;
    graceUntil: string | null;
    retryCount: number;
  } | null;
};
type Page = { counts: Record<Access, number>; subscriptions: Row[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: Row[]; next: string | null };
type Filters = { access: Access | ""; q: string; plan: string };
const PAGE = 50;
const EMPTY: Filters = { access: "", q: "", plan: "" };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (f.access) p.set("access", f.access);
  if (f.q) p.set("q", f.q);
  if (f.plan) p.set("plan", f.plan);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export default function SubscriptionsPage() {
  const [draft, setDraft] = useState({ q: "", plan: "" });
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [counts, setCounts] = useState<Record<Access, number> | null>(null);
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 조건을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/subscriptions?${query(f)}`);
    if (id !== reqId.current) return;
    if (r.ok) setCounts(r.data.counts);
    setState(r.ok ? { kind: "ok", items: r.data.subscriptions, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(applied), [applied, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/subscriptions?${query(applied, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.subscriptions], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const items = state.kind === "ok" ? state.items : [];
  const filtered = applied.access !== "" || applied.q !== "" || applied.plan !== "";
  const reset = () => {
    setDraft({ q: "", plan: "" });
    setApplied(EMPTY);
  };

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 구독 현황" />
      <main className="main">
        <PageHead title="구독 현황" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          {(["trial", "paid", "grace", "expired"] as Access[]).map((a) => (
            <div key={a} className="card pad col" style={{ gap: 4 }}>
              <span className="t-l2 c-alt">{a === "trial" ? "체험 중" : ACCESS[a].label}</span>
              <span className="t-h2" data-testid={`sub-count-${a}`}>
                {counts ? `${counts[a].toLocaleString("ko-KR")}곳` : "-"}
              </span>
            </div>
          ))}
        </div>
        <nav className="tabs" aria-label="이용 상태">
          <button type="button" className={`tab${applied.access === "" ? " on" : ""}`} aria-pressed={applied.access === ""} onClick={() => setApplied({ ...applied, access: "" })}>
            전체{counts ? ` ${TABS.reduce((n, a) => n + counts[a], 0).toLocaleString("ko-KR")}` : ""}
          </button>
          {TABS.map((a) => (
            <button key={a} type="button" className={`tab${applied.access === a ? " on" : ""}`} aria-pressed={applied.access === a} onClick={() => setApplied({ ...applied, access: a })}>
              {ACCESS[a].label}
              {counts ? ` ${counts[a].toLocaleString("ko-KR")}` : ""}
            </button>
          ))}
        </nav>
        <SearchBox onSearch={() => setApplied({ ...applied, q: draft.q.trim(), plan: draft.plan })} onReset={reset} busy={state.kind === "loading"}>
          <SearchRow label="검색어" label2="요금제" children2={
            <select className="inp" aria-label="요금제" value={draft.plan} onChange={(e) => setDraft({ ...draft, plan: e.target.value })}>
              <option value="">전체</option>
              {PLAN_FILTER.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
          }>
            <input className="inp" type="search" aria-label="쇼핑몰 이름 · 주소" placeholder="쇼핑몰 이름 · 주소" maxLength={MAX_SEARCH_LENGTH} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </SearchRow>
        </SearchBox>

        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && <ErrorState title="구독 현황을 불러오지 못했습니다." onRetry={() => void load(applied)} />}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{filtered ? "조건에 맞는 구독이 없습니다." : "아직 구독 현황이 없습니다."}</span>
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
                        <th>이용 단계</th>
                        <th>요금제</th>
                        <th>체험 종료</th>
                        <th>이용 기간 끝</th>
                        <th>다음 결제</th>
                        <th>결제 카드</th>
                        <th>결제 상태</th>
                        <th>결제 못 한 뒤 기다려 주는 날짜</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r) => (
                        <tr key={r.seller.id} data-testid="subscription-row">
                          <td>
                            <Link className="fw6" href={`/admin/partners/${r.seller.id}`}>
                              {r.seller.shopName}
                            </Link>
                            <span className="c-alt"> · 쇼핑몰 주소 {r.seller.slug}</span>
                          </td>
                          <td>
                            <span className={`bdg ${ACCESS[r.access].cls}`}>{ACCESS[r.access].label}</span>
                          </td>
                          <td>{r.plan?.name ?? "-"}</td>
                          <td className="num">{day(r.trialEndsAt)}</td>
                          <td className="num">{day(r.subscription?.currentPeriodEnd ?? null)}</td>
                          <td className="num">{r.subscription?.cancelAtPeriodEnd ? "해지 예정" : dayTime(r.subscription?.nextChargeAt ?? null)}</td>
                          <td>{r.subscription?.cardLabel ?? "-"}</td>
                          <td>{r.subscription ? <span className={`bdg ${SUBSCRIPTION_STATUS[r.subscription.status].cls}`}>{SUBSCRIPTION_STATUS[r.subscription.status].label}</span> : "구독 없음"}</td>
                          <td className="num">
                            {r.subscription?.graceUntil ? `${dayTime(r.subscription.graceUntil)} · 결제 ${r.subscription.retryCount}번 다시 시도` : "-"}
                          </td>
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
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
