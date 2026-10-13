"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { won } from "../../../_components/partners";
import { useListFilters } from "../../../_components/useListFilters";
import { DatePicker } from "../../../../../../components/admin-ui/DatePicker";

// MA-032 구독료 수납(GET /api/admin/subscription-billing, 모든 마스터 역할, 조회만). 정본: design/project/MA-032.dc.html(FINAL v295). 기간(KST 날짜, 청구 시각 기준)이 기본 「이번 달」.
// 빠른 선택(오늘 · 7일 · 이번 달 · 지난 달 · 직접 입력)과 날짜 칸을 바꾸면 바로 다시 읽는다. 결제 목록은 청구 내역(MA-024), 연체·유예·잠금 파트너스는 구독 현황(MA-023)에서 본다.
// 정본의 「유예 전환」 열은 서버가 연체 발생과 구분하지 못해(연체 직후가 유예) 넣지 않았다(정본 수정 요청 중). 요약 「청구」 금액은 서버에 없어 건수만 보인다.
type Summary = {
  charged: number;
  paid: number;
  failed: number;
  pending: number;
  paidAmount: number;
  failedAmount: number;
  retrying: number;
  pastDue: number;
  grace: number;
  pastDueAmount: number;
  locked: number;
  retryBySeq: Record<string, number>;
};
type Daily = { date: string; charged: number; paid: number; failed: number; pending: number; retried: number; pastDueStarted: number; paidAmount: number };
type Data = { range: { from: string; to: string }; summary: Summary; daily: Daily[] };
type Load = { kind: "loading" } | { kind: "error"; invalid?: boolean } | { kind: "ok"; data: Data };
type Quick = "today" | "7d" | "month" | "lastMonth" | "custom";
const QUICKS: { key: Quick; label: string }[] = [
  { key: "today", label: "오늘" },
  { key: "7d", label: "7일" },
  { key: "month", label: "이번 달" },
  { key: "lastMonth", label: "지난 달" },
  { key: "custom", label: "직접 입력" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const kstToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function quickRange(key: Exclude<Quick, "custom">): { from: string; to: string } {
  const today = kstToday();
  const [y, m] = today.split("-").map(Number);
  if (key === "today") return { from: today, to: today };
  if (key === "7d") return { from: addDay(today, -6), to: today };
  if (key === "month") return { from: `${y}-${pad(m)}-01`, to: today };
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  return { from: `${ly}-${pad(lm)}-01`, to: addDay(`${y}-${pad(m)}-01`, -1) };
}
const activeQuick = (r: { from: string; to: string }): Quick => (["today", "7d", "month", "lastMonth"] as const).find((k) => quickRange(k).from === r.from && quickRange(k).to === r.to) ?? "custom";
const dot = (iso: string) => iso.replace(/-/g, ".");
const range = (from: string, to: string) => {
  const p = new URLSearchParams();
  if (from) p.set("from", from);
  if (to) p.set("to", to);
  return p.toString();
};

function CollectionPageInner() {
  // 주소에 기간이 없으면 이번 달
  const { applied: url, apply } = useListFilters({ from: "", to: "" });
  const applied = url.from || url.to ? url : quickRange("month");
  const [draft, setDraft] = useState(applied);
  useEffect(() => setDraft(applied), [applied.from, applied.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const [custom, setCustom] = useState(false);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const reqId = useRef(0);
  const rangeError = !!draft.from && !!draft.to && draft.from > draft.to;
  const load = useCallback(async (f: { from: string; to: string }) => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Data>(`/api/admin/subscription-billing?${range(f.from, f.to)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error", invalid: r.status === 400 });
  }, []);
  useEffect(() => void load(applied), [applied.from, applied.to, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const quick: Quick = custom ? "custom" : activeQuick(applied);
  const pick = (k: Quick) => {
    if (k === "custom") return setCustom(true);
    setCustom(false);
    apply(quickRange(k));
  };
  const setDate = (next: { from: string; to: string }) => {
    setDraft(next);
    if (next.from && next.to && next.from <= next.to) apply(next);
  };

  const s = state.kind === "ok" ? state.data.summary : null;
  const rate = s && s.charged > 0 ? `${((s.paid / s.charged) * 100).toFixed(1)}%` : "-";
  const cells: { label: string; value: React.ReactNode; sub?: string; testId: string }[] = s
    ? [
        { label: "청구", value: `${s.charged}건`, testId: "charged" },
        { label: "수납", value: `${s.paid}건 · ${won(s.paidAmount)}`, sub: `수납률 ${rate}`, testId: "paid" },
        { label: "실패", value: <span className={s.failed > 0 ? "c-neg" : ""}>{s.failed}건</span>, sub: won(s.failedAmount), testId: "failed" },
        { label: "대기", value: `${s.pending}건`, sub: "재시도 예정", testId: "pending" },
        { label: "재시도", value: `${s.retrying}건`, sub: Object.entries(s.retryBySeq).map(([k, v]) => `${k}차 ${v}`).join(" · ") || undefined, testId: "retrying" },
        { label: "연체", value: `${s.pastDue}건`, sub: won(s.pastDueAmount), testId: "pastDue" },
        { label: "유예", value: `${s.grace}건`, sub: "유예 중", testId: "grace" },
        { label: "잠금", value: `${s.locked}건`, testId: "locked" },
      ]
    : [];

  return (
    <>
      <AdminTopbar crumb="요금 · 결제 › 구독료 수납" />
      <main className="main">
        <PageHead
          title="구독료 수납"
          actions={
            <Link className="btn btn-out" href="/admin/billing/invoices">
              청구 내역
            </Link>
          }
        />
        <div className="col" style={{ gap: 20 }}>
          <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div className="seg" role="radiogroup" aria-label="기간">
              {QUICKS.map((q) => (
                <button key={q.key} type="button" role="radio" aria-checked={quick === q.key} className={quick === q.key ? "on" : ""} onClick={() => pick(q.key)}>
                  {q.label}
                </button>
              ))}
            </div>
            <span className="row" style={{ gap: 6, alignItems: "center" }}>
              <DatePicker aria-label="시작일" value={draft.from} onChange={(v) => setDate({ ...draft, from: v })} />
              <span aria-hidden="true">~</span>
              <DatePicker aria-label="종료일" value={draft.to} onChange={(v) => setDate({ ...draft, to: v })} />
            </span>
            {rangeError && (
              <span className="err" role="alert">
                시작일이 종료일보다 늦습니다.
              </span>
            )}
          </div>
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" && (
            <ErrorState
              title={state.invalid ? "기간은 최대 366일까지 조회할 수 있습니다." : "구독료 수납 현황을 불러오지 못했습니다."}
              onRetry={() => void load(applied)}
            />
          )}
          {state.kind === "ok" && s && (
            <>
              <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))", overflow: "hidden" }}>
                {cells.map((c, i) => (
                  <div key={c.testId} className="col pad" style={{ gap: 4, borderLeft: i === 0 ? "none" : "1px solid var(--wds-line-normal, #e5e7eb)" }} data-testid={`collection-${c.testId}`}>
                    <span className="t-l2 c-alt">{c.label}</span>
                    <b className="t-h2">{c.value}</b>
                    {c.sub && <span className="t-c1 c-alt">{c.sub}</span>}
                  </div>
                ))}
              </div>
              <div className="col" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  <h2 className="t-hl1">일별</h2>
                  <span className="t-c1 c-alt" data-testid="collection-range">
                    {state.data.range.from === state.data.range.to ? dot(state.data.range.from) : `${dot(state.data.range.from)} ~ ${dot(state.data.range.to)}`}
                  </span>
                </div>
                <div className="card">
                  {state.data.daily.length === 0 ? (
                    <div className="st">
                      <span className="t">수납 데이터가 없습니다 · 첫 청구 후 표시됩니다</span>
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                        <thead>
                          <tr>
                            <th>날짜</th>
                            <th>청구</th>
                            <th>수납</th>
                            <th>실패</th>
                            <th>대기</th>
                            <th>수납 금액</th>
                            <th>재시도</th>
                            <th>연체 발생</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state.data.daily.map((d) => (
                            <tr key={d.date} data-testid="collection-row">
                              <td>{dot(d.date)}</td>
                              <td>{d.charged}</td>
                              <td>{d.paid}</td>
                              <td>{d.failed > 0 ? <span className="bdg b-fail">{d.failed}</span> : 0}</td>
                              <td>{d.pending}</td>
                              <td>{won(d.paidAmount)}</td>
                              <td>{d.retried}</td>
                              <td>{d.pastDueStarted}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
              <div className="col" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <h2 className="t-hl1">연체 · 유예</h2>
                  <span className="t-c1 c-alt">
                    연체 {s.pastDue}건 · {won(s.pastDueAmount)} · 유예 {s.grace}건 · 잠금 {s.locked}건
                  </span>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {["연체 목록", "유예 목록", "잠금 목록"].map((l) => (
                    <Link key={l} className="btn btn-sm btn-out" href="/admin/billing/subscriptions">
                      {l}
                    </Link>
                  ))}
                </div>
                <span className="t-c1 c-alt">연체 · 유예 · 잠금 처리는 청구 내역에서 합니다 (하루 간격 재시도 → 유예 → 잠금 · 30일 뒤 자동 해지)</span>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}

export default function CollectionPage() {
  return (
    <Suspense fallback={null}>
      <CollectionPageInner />
    </Suspense>
  );
}
