"use client";

import { formatDateTime } from "../../../../../../lib/client/format";
import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTable, DatePicker, Pagination, ListHead, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";

// SA-026 입금 확인(파트너스 관리자, 주문 › 입금 확인). 무통장 입금 대기 주문을 기한 빠른 순으로 보고, 통장 내역과 맞춰 본 뒤 단건·일괄로 입금 확인한다.
// API: GET /api/seller/payments/deposits(from/to/status/q/searchBy, summary는 판매자 전체), POST /api/seller/payments/deposits/confirm(확인 직전 /api/seller/queue/version 값을 함께 보냄).
// 확인에 보내는 expectedVersion은 목록을 불러올 때 함께 읽어 둔 값이다(보낸 사이 바뀌었으면 서버가 409로 막는다).
// 실제 입금자명은 수집하지 않는다. legacy depositorName이 있어도 구매자 실명이므로 입금자명으로 표시하지 않는다.
const PAGE = 10;
type DepositStatus = "PENDING_PAYMENT" | "OVERDUE" | "PAID" | "AUTO_CANCELLED";
type Row = { orderId: string; orderNo: number; amount: number; nickname: string; buyerName?: string; depositorName?: string; depositorNameSource?: "BUYER_MEMBER_NAME_LEGACY"; depositorNameStatus?: "NOT_COLLECTED"; status?: string; depositStatus?: DepositStatus; paidAt?: string | null; autoCancelledAt?: string | null; paymentMethod: "CARD" | "BANK_TRANSFER" | null; paymentDueAt: string | null; createdAt: string };
type Summary = { pendingCount: number; pendingAmount: number; dueWithinHourCount: number; confirmedTodayCount: number; overdueCount: number; autoCancelledTodayCount: number };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; total: number; version: number; summary?: Summary; depositorSearch: boolean };
// 입금 기한까지 남은 시간. 지났으면 「기한 지남」
function remaining(due: string | null, now: number): { text: string; urgent: boolean } {
  if (!due) return { text: "기한 없음", urgent: false };
  const ms = new Date(due).getTime() - now;
  if (ms <= 0) return { text: "기한 지남", urgent: true };
  const min = Math.floor(ms / 60_000);
  if (min < 60) return { text: `${Math.max(min, 1)}분 남음`, urgent: true };
  const h = Math.floor(min / 60);
  return { text: h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 남음` : `${h}시간 남음`, urgent: false };
}

// 입금 기한 · 자동 취소 · 입금 계좌 요약(SA-026 정본 2026-10-26): 주문 설정(SA-063)의 값을 보기만 한다. 바꾸기는 주문 설정에서만.
type DepositSettings = { policy: { autoCancelEnabled: boolean; paymentDueHours: number; dueReminderEnabled: boolean } | null; account: { bankName: string; accountNumber: string; accountHolder: string } | null | undefined };
const dueLabel = (h: number) => (h % 24 === 0 && h >= 48 ? `${h / 24}일` : `${h}시간`);
function DepositSettingsSummary() {
  const [v, setV] = useState<DepositSettings | "loading" | "error">("loading");
  useEffect(() => {
    void Promise.all([api<{ policy: NonNullable<DepositSettings["policy"]> }>("/api/seller/order-policy"), api<{ account: DepositSettings["account"] }>("/api/seller/payments/bank-account")]).then(([p, a]) => {
      setV(p.ok && a.ok ? { policy: p.data.policy, account: a.data.account } : "error");
    });
  }, []);
  return (
    <>
      <div className="sc-sec-t">
        입금 기한 · 자동 취소 · 입금 계좌<span className="nt"> 주문 설정의 값 · 여기서는 보기만</span>
      </div>
      {v === "loading" ? (
        <LoadingRows />
      ) : v === "error" ? (
        <div className="msg msg-neg" role="alert">
          <span>설정을 불러오지 못했습니다. 주문 설정에서 확인해 주십시오.</span>
        </div>
      ) : (
        <table className="au-ft" data-testid="deposit-settings">
          <tbody>
            <tr>
              <th>입금 기한</th>
              <td>
                {v.policy?.autoCancelEnabled ? (
                  <>
                    주문 후 {dueLabel(v.policy.paymentDueHours)} <span className="c-alt">· 기한이 지나면 자동 취소 (재고 복구 · 구매자 알림)</span>
                  </>
                ) : (
                  <>
                    자동 취소 꺼짐 <span className="c-alt">· 기한이 지나도 직접 취소하기 전까지 주문이 남습니다</span>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <th>입금 기한 알림</th>
              <td>
                {v.policy?.dueReminderEnabled && v.policy.autoCancelEnabled ? "켜짐" : "꺼짐"}
                {v.policy?.dueReminderEnabled && v.policy.autoCancelEnabled && <span className="c-alt"> · {v.policy.paymentDueHours > 24 ? "기한 하루 전" : "기한 1시간 전"} · 알림톡 · 안 되면 문자</span>}
              </td>
            </tr>
            <tr>
              <th>입금 계좌</th>
              <td>
                {v.account ? (
                  `${v.account.bankName} ${v.account.accountNumber} 예금주 ${v.account.accountHolder}`
                ) : (
                  <>
                    입력되지 않았습니다 <span className="c-alt">· 입력하기 전에는 무통장 입금을 받을 수 없습니다</span>
                  </>
                )}
              </td>
            </tr>
            <tr>
              <th>가상계좌 자동 확인</th>
              <td>
                <span className="bdg b-wait">준비 중</span> <span className="c-alt">주문마다 전용 계좌가 생기고 입금되면 자동 확인 · 결제 연결 뒤 제공</span>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
        <Link className="btn btn-out" href="/seller/settings/order">
          주문 설정에서 바꾸기
        </Link>
        <span className="t-c1 c-alt">입금 기한 · 자동 취소 · 알림 · 입금 계좌는 주문 설정에서만 바꿉니다</span>
      </div>
    </>
  );
}

export default function DepositsPage() {
  const listQuery = useSearchParams().toString();
  const returnTo = `/seller/orders/deposits${listQuery ? `?${listQuery}` : ""}`;
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [picked, setPicked] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const reqId = useRef(0), paging = useRef(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<DepositStatus[]>(["PENDING_PAYMENT"]);
  const [searchBy, setSearchBy] = useState<"buyer" | "depositor" | "amount">("buyer");
  const [term, setTerm] = useState("");
  const [applied, setApplied] = useState({ from: "", to: "", statuses: ["PENDING_PAYMENT"] as DepositStatus[], searchBy: "buyer" as "buyer" | "depositor" | "amount", term: "" });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async (filter = applied, target = 1) => {
    const id = ++reqId.current; paging.current = true;
    if (target === 1) setState({ kind: "loading" });
    setPicked([]);
    // 버전을 먼저 읽는다: 읽은 뒤 목록이 바뀌면 확인할 때 서버가 409로 알려 준다
    const v = await api<{ version: number }>("/api/seller/queue/version");
    if (id !== reqId.current) return;
    if (!v.ok) { paging.current = false; return setState({ kind: "error", status: v.status }); }
    const q = new URLSearchParams({ limit: String(PAGE), offset: String((target - 1) * PAGE) });
    if (filter.from) q.set("from", filter.from);
    if (filter.to) q.set("to", filter.to);
    if (filter.statuses.length !== 1 || filter.statuses[0] !== "PENDING_PAYMENT") q.set("status", filter.statuses.length ? filter.statuses.join(",") : "ALL");
    if (filter.term.trim()) { q.set("q", filter.term.trim()); q.set("searchBy", filter.searchBy); }
    const r = await api<{ deposits: Row[]; total: number; summary?: Summary; capabilities?: { depositorSearch: boolean } }>(`/api/seller/payments/deposits?${q}`);
    if (id !== reqId.current) return;
    paging.current = false;
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setPicked([]);
    const pages = Math.ceil(r.data.total / PAGE);
    if (target > (pages || 1)) { void load(filter, pages || 1); return; }
    setPage(target);
    setState({ kind: "ok", rows: r.data.deposits, total: r.data.total, version: v.data.version, summary: r.data.summary, depositorSearch: r.data.capabilities?.depositorSearch === true });
  }, []);
  useEffect(() => {
    void load({ from: "", to: "", statuses: ["PENDING_PAYMENT"], searchBy: "buyer", term: "" });
  }, [load]);
  useScrollRestore("seller-deposits", state.kind === "ok");

  const turnPage = (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > Math.ceil(state.total / PAGE)) return;
    void load(applied, target);
  };

  const rows = state.kind === "ok" ? state.rows : [];
  const payable = rows.filter((r) => ["PENDING_PAYMENT", "OVERDUE"].includes(r.depositStatus ?? (r.paymentDueAt && new Date(r.paymentDueAt).getTime() <= now ? "OVERDUE" : "PENDING_PAYMENT")));
  const allPicked = payable.length > 0 && picked.length === payable.length;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const overdue = rows.filter((r) => (r.depositStatus ?? (r.paymentDueAt && new Date(r.paymentDueAt).getTime() <= now ? "OVERDUE" : "PENDING_PAYMENT")) === "OVERDUE").length;
  const canSearchDepositor = state.kind === "ok" && state.depositorSearch;

  return (
    <>
      <Topbar crumb="주문 › 입금 확인" />
      <main className="main">
        <PageHead
          title="입금 확인"
          actions={
            <Link className="btn btn-out btn-level-secondary" href="/seller/settings/order">
              주문 설정
            </Link>
          }
        />
        <span className="t-c1 c-alt">실제 입금자명은 수집하지 않습니다. 통장 내역에서 직접 확인한 뒤에만 「입금 확인」을 눌러 주십시오.</span>

        {state.kind === "ok" && state.summary && <div className="card row" style={{ gap: 20, flexWrap: "wrap" }} aria-label="입금 현황">
          <span>입금 대기 <b>{state.summary.pendingCount}건 · {won(state.summary.pendingAmount)}</b></span>
          <span>1시간 안에 기한 <b>{state.summary.dueWithinHourCount}건</b></span>
          <span>오늘 확인 <b>{state.summary.confirmedTodayCount}건</b></span>
          <span>기한 지남 <b>{state.summary.overdueCount}건</b></span>
          <span>오늘 자동 취소 <b>{state.summary.autoCancelledTodayCount}건</b></span>
        </div>}

        <SearchBox onSearch={() => {
          if (from && to && from > to) return setToast({ text: "시작일은 종료일보다 앞이어야 합니다", neg: true });
          setApplied({ from, to, statuses, searchBy, term });
          void load({ from, to, statuses, searchBy, term });
        }} onReset={() => {
          setFrom(""); setTo(""); setStatuses(["PENDING_PAYMENT"]); setSearchBy("buyer"); setTerm("");
          const fresh = { from: "", to: "", statuses: ["PENDING_PAYMENT"] as DepositStatus[], searchBy: "buyer" as const, term: "" };
          setApplied(fresh); void load(fresh);
        }} busy={state.kind === "loading"}>
          <SearchRow label="기간"><DatePicker aria-label="시작일" value={from} onChange={setFrom} /><span aria-hidden="true"> ~ </span><DatePicker aria-label="종료일" value={to} onChange={setTo} /></SearchRow>
          <SearchRow label="상태"><div className="row" style={{ gap: 12, flexWrap: "wrap" }}>{([["PENDING_PAYMENT", "입금 대기"], ["OVERDUE", "기한 지남"], ["PAID", "입금 확인"], ["AUTO_CANCELLED", "자동 취소"]] as const).map(([value, label]) => <label className="ck" key={value}><input type="checkbox" checked={statuses.includes(value)} onChange={(e) => setStatuses(e.target.checked ? [...statuses, value] : statuses.filter((s) => s !== value))} />{label}</label>)}</div></SearchRow>
          <SearchRow label="검색"><div className="row" style={{ gap: 8, flexWrap: "wrap" }}><select className="inp" aria-label="검색 기준" value={searchBy} onChange={(e) => setSearchBy(e.target.value as typeof searchBy)}><option value="buyer">구매자</option><option value="amount">금액</option><option value="depositor" disabled={!canSearchDepositor}>입금자명</option></select><input className="inp" aria-label="검색어" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={searchBy === "depositor" && !canSearchDepositor ? "실제 입금자명 미수집 · 검색할 수 없음" : searchBy === "amount" ? "정확한 금액" : "검색어"} disabled={searchBy === "depositor" && !canSearchDepositor} />{!canSearchDepositor && <span className="t-c1 c-alt">실제 입금자명을 수집하지 않아 검색할 수 없습니다</span>}</div></SearchRow>
        </SearchBox>

        <section className="au-list-section" style={{ overflow: "visible" }}>
          {state.kind === "ok" && (
            <ListHead
              total={state.total}
              actions={
                <>
                  {overdue > 0 && <span className="t-l2 c-alt">기한 지남 {overdue}건</span>}
                  {picked.length ? <Link className="btn btn-dense btn-w-xl" href={`/seller/orders/deposits/confirm?${new URLSearchParams({ ids: rows.filter((r) => picked.includes(r.orderId)).map((r) => r.orderId).join(","), returnTo })}`}>선택 입금 확인 ({picked.length})</Link> : <button className="btn btn-dense btn-w-xl" type="button" disabled>선택 입금 확인</button>}
                </>
              }
            />
          )}

          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문 · 배송" /> : state.status === 402 ? <div className="card"><Locked /></div> : <div className="card"><ErrorState title="입금 대기 주문을 불러오지 못했습니다" onRetry={() => void load(applied)} /></div>)}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="card"><div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">입금 전 주문이 없습니다</span>
              <span className="s">무통장 주문이 들어오면 여기에 표시됩니다.</span>
            </div></div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <ListTable>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="dep-w-chk">
                      <input className="cbx" type="checkbox" aria-label="입금 대기 전체 선택" checked={allPicked} onChange={() => setPicked(allPicked ? [] : payable.map((r) => r.orderId))} />
                    </th>
                    <th>주문</th>
                    <th>입금자 확인</th>
                    <th>금액</th>
                    <th>결제 방식</th>
                    <th className="dep-due">입금 기한</th>
                    <th>남은 시간</th>
                    <th className="dep-w-act" aria-label="작업" />
                  </tr>
                </thead>
                <tbody>
                    {rows.map((o) => {
                    const left = remaining(o.paymentDueAt, now);
                      const stateLabel = ({ PENDING_PAYMENT: "입금 대기", OVERDUE: "기한 지남", PAID: "입금 확인", AUTO_CANCELLED: "자동 취소" } as const)[o.depositStatus ?? (o.paymentDueAt && new Date(o.paymentDueAt).getTime() <= now ? "OVERDUE" : "PENDING_PAYMENT")];
                    return (
                      <tr key={o.orderId} data-testid="deposit-row">
                        <td>
                          <input className="cbx" type="checkbox" aria-label={`${o.nickname} 선택`} checked={picked.includes(o.orderId)} disabled={!payable.some((r) => r.orderId === o.orderId)} onChange={() => toggle(o.orderId)} />
                        </td>
                        <td className="col-text">
                          <Link href={`/seller/orders/${o.orderId}`} className="fw6">
                            {o.nickname}
                          </Link>
                          <div className="t-c1 c-alt num">{formatDateTime(o.createdAt)} 주문</div>
                        </td>
                        <td><span className="t-c1 c-alt">실제 입금자명 미수집</span></td>
                        <td className="num">{won(o.amount)}</td>
                        <td>{o.paymentMethod === "BANK_TRANSFER" ? "무통장 입금" : o.paymentMethod === "CARD" ? "카드" : "선택 전"}</td>
                        <td className="num dep-due">{o.paymentDueAt ? formatDateTime(o.paymentDueAt) : "-"}</td>
                        <td>{left.urgent ? <b style={{ color: "var(--neg, #c0262c)" }}>{left.text}</b> : left.text}</td>
                        <td>
                          {payable.some((r) => r.orderId === o.orderId) ? <Link className="btn btn-sm btn-w-sm" href={`/seller/orders/deposits/confirm?${new URLSearchParams({ ids: o.orderId, returnTo })}`}>입금 확인</Link> : <span className="t-c1 c-alt">{stateLabel}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ListTable>
          )}
          {state.kind === "ok" && state.total > PAGE && <Pagination page={page} pageCount={Math.ceil(state.total / PAGE)} onChange={turnPage} />}
        </section>
        <DepositSettingsSummary />
      </main>

      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
