"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { dayTime, won, type SellerStatus } from "../../../_components/partners";
import { useListFilters } from "../../../_components/useListFilters";

// MA-031 결제 연결 상태(GET /api/admin/pg-status, 모든 마스터 역할, 조회만). 키 값은 받지 않고 설정 여부만 본다.
// 실패 문구(lastFailureMessage)는 서버가 준 그대로 보여 준다. 50건씩 이어서 불러온다.
// 게이트웨이 24시간 요약(summary24h)은 기간과 상관없이 항상 직전 24시간이고, 기간(period)은 목록의 「실패」 집계 기준이다.
type Result = { lastSuccessAt: string | null; lastFailureAt: string | null; lastFailureCode: string | null; lastFailureMessage: string | null };
type Summary24h = {
  successCount: number;
  failureCount: number;
  failedSellerCount: number;
  cancelsPending: number;
  cancelsFailed: number;
  lastSuccess: { at: string; sellerName: string; amount: number } | null;
  lastFailure: { at: string; sellerName: string; code: string | null; message: string | null } | null;
};
type Gateway = Result & { provider: string; configured: boolean; mode: "sandbox" | "live"; summary24h: Summary24h };
type SellerPg = Result & {
  seller: { id: string; slug: string; shopName: string; status: SellerStatus };
  live: boolean;
  failures24h: number;
  failuresInPeriod: number;
  cancelsPending: number;
  cancelsFailed: number;
};
type Counts = { all: number; failed: number; cancel: number };
type Page = { gateway: Gateway; counts: Counts; sellers: SellerPg[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; gateway: Gateway; counts: Counts; items: SellerPg[]; next: string | null };
type Filters = { q: string; status: "failed" | "cancel" | "all"; period: "24h" | "7d" | "30d" };
const DEFAULTS: Filters = { q: "", status: "failed", period: "24h" };
const PERIODS: Record<Filters["period"], string> = { "24h": "24시간", "7d": "7일", "30d": "30일" };

const PAGE = 50;
const qs = (f: Filters, cursor?: string) => {
  const p = new URLSearchParams({ limit: String(PAGE), status: f.status, period: f.period });
  if (f.q) p.set("q", f.q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
};
// 어제·오늘 표시(정본 「어제 23:40」): 같은 날이면 시각만
const short = (iso: string | null) => (iso ? dayTime(iso).slice(11) : "-");

function PgStatusPageInner() {
  const { applied, draft, setDraft, apply, reset } = useListFilters<Filters>(DEFAULTS);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/pg-status?${qs(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", gateway: r.data.gateway, counts: r.data.counts, items: r.data.sellers, next: r.data.nextCursor } : { kind: "error" });
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
  const sum = g?.summary24h ?? null;
  const counts = state.kind === "ok" ? state.counts : null;
  return (
    <>
      <AdminTopbar crumb="파트너스 › 결제 연결 상태" />
      <main className="main">
        <PageHead description="파트너스별 카드 결제 연결 상태와 오류 내역을 조회합니다."
          title="결제 연결 상태"
          actions={
            <Link className="btn btn-out" href="/admin/billing/invoices">
              청구 내역
            </Link>
          }
        />
        <div className="col" style={{ gap: 20 }}>
          {g && !g.configured && (
            <div className="msg msg-neg" role="status">
              <span>
                <b>플랫폼 결제 키가 설정되지 않았습니다.</b> 모든 구독 결제·재시도가 멈춥니다 · 키 입력은 개발 담당에게 요청해 주십시오. <Link href="/admin/settings/policy">플랫폼 정책에서 확인</Link>
              </span>
            </div>
          )}
          {g && g.configured && g.mode === "sandbox" && (
            <div className="msg msg-cau" role="status">
              <span>
                <b>게이트웨이가 테스트 모드입니다.</b> 실제 청구가 되지 않습니다.
              </span>
            </div>
          )}
          {g && g.configured && sum && sum.failureCount === 0 && sum.cancelsPending === 0 && sum.cancelsFailed === 0 && (
            <div className="msg msg-pos" role="status">
              <span>24시간 안 결제 실패와 취소 대기가 없습니다.</span>
            </div>
          )}
          {g && sum && (
            <>
              <div className="card pad col" style={{ gap: 8 }} data-testid="pg-gateway">
                <span className="t-hl2">플랫폼 결제 게이트웨이</span>
                <table className="au-ft">
                  <colgroup>
                    <col style={{ width: 150 }} />
                    <col />
                  </colgroup>
                  <tbody>
                    <tr>
                      <th>게이트웨이</th>
                      <td>나이스페이 · 플랫폼 키 1개로 모든 파트너스 구독 결제를 처리합니다</td>
                    </tr>
                    <tr>
                      <th>설정 여부</th>
                      <td>
                        <span className={`bdg ${g.configured ? "b-done" : "b-fail"}`}>{g.configured ? "설정됨" : "미설정"}</span> <span className="c-alt">· 값은 표시하지 않습니다</span>
                      </td>
                    </tr>
                    <tr>
                      <th>모드</th>
                      <td>
                        <span className="bdg b-info">{g.mode === "sandbox" ? "테스트" : "운영"}</span> <span className="c-alt">{g.mode === "sandbox" ? "· 실제 청구가 되지 않습니다" : "· 테스트 모드 아님"}</span>
                      </td>
                    </tr>
                    <tr>
                      <th>최근 성공</th>
                      <td>{sum.lastSuccess ? `${dayTime(sum.lastSuccess.at)} · ${sum.lastSuccess.sellerName} · ${won(sum.lastSuccess.amount)}` : "-"}</td>
                    </tr>
                    <tr>
                      <th>최근 실패</th>
                      <td>{sum.lastFailure ? `${dayTime(sum.lastFailure.at)} · ${sum.lastFailure.sellerName} · ${sum.lastFailure.message ?? "-"}${sum.lastFailure.code ? ` · 실패 코드 ${sum.lastFailure.code}` : ""}` : "-"}</td>
                    </tr>
                    <tr>
                      <th>24시간</th>
                      <td>
                        성공 {sum.successCount} · 실패 {sum.failureCount} · 취소 대기 {sum.cancelsPending} · 취소 실패 {sum.cancelsFailed}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                {[
                  ["24시간 성공", String(sum.successCount), ""],
                  ["24시간 실패", String(sum.failureCount), sum.failedSellerCount > 0 ? `파트너스 ${sum.failedSellerCount}곳` : ""],
                  ["취소 대기", String(sum.cancelsPending), ""],
                  ["취소 실패", String(sum.cancelsFailed), ""],
                  ["마지막 성공", sum.lastSuccess ? short(sum.lastSuccess.at) : "-", sum.lastSuccess?.sellerName ?? ""],
                  ["마지막 실패", sum.lastFailure ? short(sum.lastFailure.at) : "-", sum.lastFailure?.sellerName ?? ""],
                ].map(([label, value, note]) => (
                  <div key={label} className="card pad col" style={{ gap: 4 }}>
                    <span className="t-l2 c-alt">{label}</span>
                    <span className="t-h2">{value}</span>
                    {note && <span className="t-c1 c-alt">{note}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
          <SearchBox
            onSearch={() => apply({ ...draft, q: draft.q.trim() })}
            onReset={() => reset()}
            busy={state.kind === "loading"}
          >
            <SearchRow
              label="상태"
              label2="기간"
              children2={
                <select className="inp" aria-label="기간" value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value as Filters["period"] })}>
                  {(Object.keys(PERIODS) as Filters["period"][]).map((k) => (
                    <option key={k} value={k}>
                      {PERIODS[k]}
                    </option>
                  ))}
                </select>
              }
            >
              <span className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                {(
                  [
                    ["failed", "실패 있음", counts?.failed],
                    ["cancel", "취소 대기 · 실패", counts?.cancel],
                    ["all", "전체", counts?.all],
                  ] as const
                ).map(([k, label, n]) => (
                  <label key={k} className="chk">
                    <input type="radio" name="pg-status" checked={draft.status === k} onChange={() => setDraft({ ...draft, status: k })} />
                    {label}
                    {n !== undefined && ` ${n}`}
                  </label>
                ))}
              </span>
            </SearchRow>
            <SearchRow label="파트너스">
              <input className="inp" aria-label="쇼핑몰 이름 또는 주소" placeholder="쇼핑몰 이름" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
            </SearchRow>
          </SearchBox>
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="결제 연결 상태를 불러오지 못했습니다." onRetry={() => void load(applied)} />}
            {state.kind === "ok" &&
              (state.items.length === 0 ? (
                <div className="st">
                  <span className="t">조건에 맞는 파트너스가 없습니다.</span>
                </div>
              ) : (
                <>
                  <ListHead total={state.items.length} loaded={state.next !== null} />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>파트너스</th>
                          <th>마지막 성공</th>
                          <th>마지막 실패</th>
                          <th>실패 코드</th>
                          <th>{PERIODS[applied.period]} 실패</th>
                          <th>취소 대기 · 실패</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.items.map((r) => (
                          <tr key={r.seller.id} data-testid="pg-row">
                            <td>
                              <b>{r.seller.shopName}</b>
                              {r.live && <span className="bdg b-done"> LIVE</span>}
                            </td>
                            <td>{dayTime(r.lastSuccessAt)}</td>
                            <td>{dayTime(r.lastFailureAt)}</td>
                            <td className="col-text">{r.lastFailureMessage ? `${r.lastFailureMessage}${r.lastFailureCode ? ` · ${r.lastFailureCode}` : ""}` : "-"}</td>
                            <td>{r.failuresInPeriod}</td>
                            <td>
                              {r.cancelsPending || r.cancelsFailed ? `${r.cancelsPending} · ${r.cancelsFailed}` : "— · —"}
                            </td>
                            <td>
                              <Link className="btn btn-sm btn-out" href={`/admin/partners/${r.seller.id}`}>
                                상세
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
          <span className="t-c1 c-alt">실패 코드는 나이스페이 응답 코드 그대로 기록합니다 · 재시도 · 유예 · 잠금 처리는 청구 내역에서 합니다 · 취소 대기 = 승인 취소 요청 뒤 결제대행사 응답 대기</span>
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
