"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead, SearchBox, SearchRow, useConfirm } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { DatePicker } from "../../../../../../components/admin-ui/DatePicker";
import { MAX_SEARCH_LENGTH } from "../../../../../../components/seller/format";
import { listDefaults } from "../../../../../../lib/client/filterDefaults";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { PLAN_FILTER, won } from "../../../_components/partners";
import { safeUrl } from "../../../_components/payments";
import { useListFilters } from "../../../_components/useListFilters";

// MA-024 청구·결제 내역(구독료, GET /api/admin/billing/invoices, 모든 마스터 역할 조회). 정본: design/project/MA-024.dc.html(FINAL v287).
// 월 선택(이전 달·이번 달·기간 지정) → 월 요약 5칸 → 검색(상태·요금제·파트너스·실패만) → 목록(예정 청구가 같은 표에 섞여 나옴). 조건은 주소에 남는다.
// 「실패 건 재시도」는 최고관리자·운영만(billing.manage)이고 등록된 카드로 실제 결제를 시도하므로 확인 창을 거친다. 내보내기는 같은 조건의 CSV.
type State = "PAID" | "PENDING" | "RETRYING" | "OVERDUE" | "FAILED" | "REFUNDED" | "SCHEDULED";
type Item = {
  id: string;
  paymentId: string | null;
  state: State;
  at: string;
  amount: number;
  amountEstimated: boolean;
  kind: "PERIOD" | "PRORATION";
  seller: { id: string; slug: string; shopName: string };
  planName: string | null;
  periodStart: string | null;
  paymentMethod: string | null;
  receipt: "ISSUED" | "NOT_ISSUED" | "CANCELED" | "SCHEDULED";
  receiptUrl: string | null;
  failureReason: string | null;
  canRetry: boolean;
};
type Summary = {
  total: { count: number; amount: number };
  paid: { count: number; amount: number };
  failed: { count: number; amount: number; retrying: number; overdue: number };
  pending: { count: number };
  refunded: { count: number; amount: number };
  scheduled: { count: number; estimatedAmount: number };
};
type Data = { range: { from: string; to: string }; summary: Summary; items: Item[]; total: number; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Data };
// 기간은 이 화면의 월 선택(이전 달·이번 달·기간 지정)이 정본이라 공통 기본 기간(최근 1개월)을 쓰지 않는다. 최신순은 서버 고정, 쪽 크기는 공통 20.
const EMPTY = listDefaults({ month: "", from: "", to: "", state: "", plan: "", q: "", failedOnly: "", sellerId: "" }, { period: null });
type Filters = typeof EMPTY;
const SEARCH_KEYS = ["state", "plan", "q", "failedOnly"] as const;

const STATE: Record<State, { label: string; cls: string }> = {
  PAID: { label: "결제 완료", cls: "b-done" },
  PENDING: { label: "진행 중", cls: "b-wait" },
  RETRYING: { label: "실패 · 재시도", cls: "b-warn" },
  OVERDUE: { label: "연체", cls: "b-fail" },
  FAILED: { label: "실패", cls: "b-fail" },
  REFUNDED: { label: "환불 완료", cls: "b-gray" },
  SCHEDULED: { label: "예정", cls: "b-info" },
};
// 정본의 상태 선택지(진행 중·실패는 목록에는 나오지만 정본 선택지에는 없다)
const STATE_OPTIONS: State[] = ["PAID", "RETRYING", "SCHEDULED", "REFUNDED", "OVERDUE"];
const RECEIPT = { ISSUED: "발행", NOT_ISSUED: "미발행", CANCELED: "취소", SCHEDULED: "예정" } as const;
const RETRY_REASON: Record<string, string> = {
  not_found: "청구를 찾을 수 없습니다",
  not_failed: "실패한 청구가 아닙니다",
  not_latest: "최신 청구가 아닙니다",
  not_retryable: "다시 결제할 수 없는 구독입니다",
  too_soon: "5분 안에 다시 시도했습니다",
  not_charged: "결제가 되지 않았습니다",
  charge_failed: "카드가 다시 거절됐습니다",
  charge_pending: "결제 결과를 기다리는 중입니다",
};

const kstMonth = (offset = 0) => {
  const k = new Date(Date.now() + 9 * 3_600_000);
  const d = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthNo = (ym: string) => `${Number(ym.slice(5))}월`;

function params(f: Filters, extra: Record<string, string> = {}) {
  const p = new URLSearchParams(extra);
  if (f.from || f.to) {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  } else if (f.month) p.set("month", f.month);
  for (const k of [...SEARCH_KEYS, "sellerId"] as const) if (f[k]) p.set(k, f[k]);
  return p;
}

function Invoices() {
  const { me } = useAdmin();
  const canRetry = adminCan(me.role, "billing.manage");
  const { confirm } = useConfirm();
  const { applied, draft, setDraft, apply } = useListFilters<Filters>(EMPTY);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [custom, setCustom] = useState(false);
  const [rangeError, setRangeError] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const cursor = cursors[cursors.length - 1];
  const key = JSON.stringify({ applied, cursor });
  const reqId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const id = ++reqId.current;
      if (!silent) setState({ kind: "loading" });
      const p = params(applied, { limit: applied.size });
      if (cursor) p.set("cursor", cursor);
      const r = await adminApi<Data>(`/api/admin/billing/invoices?${p}`);
      if (id !== reqId.current) return;
      if (r.ok) setState({ kind: "ok", data: r.data });
      else if (!silent) setState({ kind: "error" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useScrollRestore("admin-invoices", state.kind === "ok");

  const customActive = custom || !!(applied.from || applied.to);
  const thisMonth = kstMonth();
  const prevMonth = kstMonth(-1);
  const activeMonth = customActive ? "" : applied.month || thisMonth;
  const go = (next: Filters) => {
    setCursors([null]);
    apply(next);
  };
  const pickMonth = (m: string) => {
    setCustom(false);
    setRangeError(false);
    go({ ...applied, month: m === thisMonth ? "" : m, from: "", to: "" });
  };
  const search = () => {
    if (draft.from && draft.to && draft.from > draft.to) return setRangeError(true);
    setRangeError(false);
    go({ ...applied, state: draft.state, plan: draft.plan, q: draft.q, failedOnly: draft.failedOnly, from: customActive ? draft.from : "", to: customActive ? draft.to : "" });
  };
  const reset = () => {
    setRangeError(false);
    go({ ...EMPTY, month: applied.month, from: applied.from, to: applied.to, sellerId: applied.sellerId });
  };

  const data = state.kind === "ok" ? state.data : null;
  const items = data?.items ?? [];
  const retryable = items.filter((i) => i.canRetry && i.paymentId);
  const filtered = !!(applied.state || applied.plan || applied.q || applied.failedOnly || applied.sellerId);
  const s = data?.summary;
  const label = data ? (data.range.from.slice(0, 7) === data.range.to.slice(0, 7) ? monthNo(data.range.from.slice(0, 7)) : "기간") : "";

  const retry = async () => {
    const ids = retryable.map((i) => i.paymentId!);
    let message = "";
    const ok = await confirm({
      title: `실패한 청구 ${ids.length}건을 다시 결제하시겠습니까?`,
      body: "등록된 카드로 지금 바로 결제가 시도됩니다 · 결과는 건별로 안내되고 로그 추적에 남습니다 · 이 화면에 보이는 재시도 가능 건만 대상입니다",
      confirmLabel: "다시 결제",
      danger: true,
      run: async () => {
        const r = await adminApi<{ results: { paymentId: string; ok: boolean; reason?: string }[]; succeeded: number; failed: number }>("/api/admin/billing/invoices/retry", { method: "POST", json: { paymentIds: ids } });
        if (!r.ok) return failMessage(r, "다시 결제하지 못했습니다. 목록은 바뀌지 않았습니다.");
        const bad = r.data.results.find((x) => !x.ok);
        const shop = bad ? items.find((i) => i.paymentId === bad.paymentId)?.seller.shopName : "";
        message = `성공 ${r.data.succeeded}건 · 실패 ${r.data.failed}건${bad ? ` — ${shop}: ${RETRY_REASON[bad.reason ?? ""] ?? "처리하지 못했습니다"}` : ""}`;
        return undefined;
      },
    });
    if (!ok) return;
    setToast({ text: message, neg: message.includes("실패") && !message.includes("실패 0건") });
    void load(true);
  };

  const kpi = (title: string, value: string, sub?: string, hot?: boolean) => (
    <div className="card" style={{ padding: 16 }}>
      <div className="t-c1 c-alt">{title}</div>
      <div className={`t-h2 fw6 ${hot ? "c-neg" : ""}`}>{value}</div>
      {sub && <div className="t-c1 c-alt">{sub}</div>}
    </div>
  );

  return (
    <>
      <AdminTopbar crumb="요금 · 결제 › 청구 · 결제 내역" />
      <main className="main">
        <PageHead
          title="청구 · 결제"
          actions={
            <>
              {canRetry && (
                <button className="btn btn-out" type="button" disabled={retryable.length === 0} title={retryable.length === 0 ? "다시 결제할 수 있는 실패 건이 없습니다" : undefined} onClick={() => void retry()}>
                  실패 건 재시도{retryable.length > 0 ? ` ${retryable.length}` : ""}
                </button>
              )}
              <a className="btn btn-out" href={`/api/admin/billing/invoices/export?${params(applied)}`} download>
                내보내기
              </a>
            </>
          }
        />
        <div className="col" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="청구 기간">
            {[prevMonth, thisMonth].map((m) => (
              <button key={m} type="button" className={`btn btn-sm ${activeMonth === m ? "" : "btn-out"}`} aria-pressed={activeMonth === m} onClick={() => pickMonth(m)}>
                {monthNo(m)}
              </button>
            ))}
            <button type="button" className={`btn btn-sm ${customActive ? "" : "btn-out"}`} aria-pressed={customActive} onClick={() => setCustom(true)}>
              기간 지정
            </button>
          </div>
          {s && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }} data-testid="invoice-summary">
              {kpi(`${label} 청구`, `${s.total.count}건`, won(s.total.amount))}
              {kpi("결제 완료", `${s.paid.count}`, won(s.paid.amount))}
              {kpi("실패 · 재시도 중", `${s.failed.count}`, s.failed.count > 0 ? `재시도 중 ${s.failed.retrying} · 연체 ${s.failed.overdue}` : undefined, s.failed.count > 0)}
              {kpi("예정 (미도래)", `${s.scheduled.count}`, s.scheduled.count > 0 ? `예상 ${won(s.scheduled.estimatedAmount)}` : undefined)}
              {kpi("환불", `${s.refunded.count}`, s.refunded.count > 0 ? won(s.refunded.amount) : undefined)}
            </div>
          )}
          <SearchBox onSearch={search} onReset={reset} busy={state.kind === "loading"}>
            {customActive && (
              <SearchRow label="청구 기간">
                <DatePicker aria-label="청구 시작일" value={draft.from} onChange={(v) => setDraft({ ...draft, from: v })} />
                <span aria-hidden="true">~</span>
                <DatePicker aria-label="청구 종료일" value={draft.to} onChange={(v) => setDraft({ ...draft, to: v })} />
                {rangeError && (
                  <span className="err" role="alert">
                    시작일이 종료일보다 늦습니다.
                  </span>
                )}
              </SearchRow>
            )}
            <SearchRow label="상태">
              <select className="inp" aria-label="상태" value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value })}>
                <option value="">전체</option>
                {STATE_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {STATE[v].label}
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
            <SearchRow label="파트너스">
              <input className="inp" type="search" aria-label="파트너스" placeholder="쇼핑몰 이름 · 주소" maxLength={MAX_SEARCH_LENGTH} value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
            </SearchRow>
            <SearchRow label="기타">
              <label className="chk">
                <input className="chkbox" type="checkbox" checked={draft.failedOnly === "1"} onChange={(e) => setDraft({ ...draft, failedOnly: e.target.checked ? "1" : "" })} />
                결제 실패 · 재시도만
              </label>
            </SearchRow>
          </SearchBox>
          {applied.sellerId && (
            <div className="row" style={{ gap: 8 }}>
              <span className="t-l2 c-alt">한 파트너스의 내역만 보고 있습니다.</span>
              <button className="btn btn-sm btn-out" type="button" onClick={() => go({ ...applied, sellerId: "" })}>
                전체 보기
              </button>
            </div>
          )}
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="청구 · 결제 내역을 불러오지 못했습니다." onRetry={() => void load()} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{filtered ? "일치하는 청구가 없습니다." : "이 기간 청구가 없습니다."}</span>
                  {filtered && (
                    <button className="btn btn-sm btn-out" type="button" onClick={reset}>
                      초기화
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="row" style={{ padding: "12px 16px", gap: 8 }}>
                    <b>불러온 {items.length}건</b>
                    <span className="t-c1 c-alt">(이 기간 {state.data.total}건)</span>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>청구</th>
                          <th>파트너스</th>
                          <th>항목</th>
                          <th>금액 (부가세 포함)</th>
                          <th>청구일</th>
                          <th>결제 수단</th>
                          <th>상태</th>
                          <th>매출전표</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((i) => {
                          const detail = i.paymentId ? `/admin/billing/invoices/${i.paymentId}` : `/admin/partners/${i.seller.id}`;
                          const url = i.receipt === "ISSUED" ? safeUrl(i.receiptUrl) : null;
                          return (
                            <tr key={i.id} data-testid="invoice-row">
                              <td className="col-text">
                                <Link className="fw6" href={detail}>
                                  {i.kind === "PRORATION" ? "차액" : "구독료"} · {formatDateTime(i.at)}
                                  {i.state === "SCHEDULED" ? " 청구 예정" : ""}
                                </Link>
                                {i.failureReason && (i.state === "RETRYING" || i.state === "OVERDUE" || i.state === "FAILED") && (
                                  <span className="t-c1 c-alt" style={{ display: "block" }}>
                                    {i.failureReason}
                                  </span>
                                )}
                              </td>
                              <td>
                                <Link className="fw6" href={`/admin/partners/${i.seller.id}`}>
                                  {i.seller.shopName}
                                </Link>
                              </td>
                              <td className="col-text">
                                {i.planName ?? "-"}
                                {i.periodStart ? ` ${Number(formatDate(i.periodStart).slice(5, 7))}월` : ""}
                              </td>
                              <td className="num">
                                {won(i.amount)}
                                {i.amountEstimated && <span className="t-c1 c-alt"> (예상)</span>}
                              </td>
                              <td className="num">{formatDate(i.at, "-")}</td>
                              <td>{i.paymentMethod ?? "미등록"}</td>
                              <td>
                                <span className={`bdg ${STATE[i.state].cls}`}>{STATE[i.state].label}</span>
                              </td>
                              <td>
                                {url ? (
                                  <a href={url} target="_blank" rel="noopener noreferrer">
                                    {RECEIPT.ISSUED}
                                  </a>
                                ) : (
                                  RECEIPT[i.receipt]
                                )}
                              </td>
                              <td>
                                <div className="acts2">
                                  <Link className="btn btn-sm btn-out" href={detail}>
                                    상세
                                  </Link>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {(cursors.length > 1 || state.data.nextCursor) && (
                    <div className="row" style={{ gap: 8, justifyContent: "center", padding: 12 }}>
                      <button className="btn btn-sm btn-out" type="button" disabled={cursors.length <= 1} onClick={() => setCursors((c) => c.slice(0, -1))}>
                        ‹ 이전
                      </button>
                      <button className="btn btn-sm btn-out" type="button" disabled={!state.data.nextCursor} onClick={() => state.data.nextCursor && setCursors((c) => [...c, state.data.nextCursor])}>
                        다음 ›
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
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
