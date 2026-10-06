"use client";

import { formatDateTime } from "../../../../../../lib/client/format";
import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { DatePicker, ListHead, Modal, PageHead, SearchBox, SearchRow } from "../../../../../../components/admin-ui";
import { useScrollRestore } from "../../../../../../lib/client/navigation";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";

// SA-026 입금 확인(파트너스 관리자, 주문 › 입금 확인). 무통장 입금 대기 주문을 기한 빠른 순으로 보고, 통장 내역과 맞춰 본 뒤 단건·일괄로 입금 확인한다.
// API: GET /api/seller/payments/deposits(입금 대기 목록), POST /api/seller/payments/deposits/confirm(확인 직전 /api/seller/queue/version 값을 함께 보냄).
// 확인에 보내는 expectedVersion은 목록을 불러올 때 함께 읽어 둔 값이다(보낸 사이 바뀌었으면 서버가 409로 막는다).
// 입금자명은 구매자 개인정보 열람 권한이 있을 때만 서버가 내려 준다.
const PAGE = 20;
type DepositStatus = "PENDING_PAYMENT" | "OVERDUE" | "PAID" | "AUTO_CANCELLED";
type Row = { orderId: string; orderNo: number; amount: number; nickname: string; buyerName?: string; depositorName?: string; depositorNameSource?: "BUYER_MEMBER_NAME_LEGACY"; depositorNameStatus?: "NOT_COLLECTED"; status?: string; depositStatus?: DepositStatus; paidAt?: string | null; autoCancelledAt?: string | null; paymentMethod: "CARD" | "BANK_TRANSFER" | null; paymentDueAt: string | null; createdAt: string };
type Summary = { pendingCount: number; pendingAmount: number; dueWithinHourCount: number; confirmedTodayCount: number; overdueCount: number; autoCancelledTodayCount: number };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; total: number; version: number; summary?: Summary; depositorSearch: boolean };
type Result = { orderId: string; result: "paid" | "stock_shortage" | "already_paid" | "card_in_progress" | "not_payable" | "not_found" };

const RESULT_TEXT: Record<Exclude<Result["result"], "paid">, string> = {
  stock_shortage: "재고가 부족해 입금 확인을 하지 못했습니다. 재고를 늘린 뒤 다시 눌러 주십시오.",
  already_paid: "이미 입금 확인된 주문입니다",
  card_in_progress: "카드 결제가 진행 중입니다. 잠시 뒤 다시 확인해 주십시오.",
  not_payable: "입금 확인을 할 수 없는 주문입니다. 주문 상세에서 상태를 확인해 주십시오.",
  not_found: "주문을 찾지 못했습니다",
};

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

export default function DepositsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
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

  const load = useCallback(async (filter = applied, append = false, offset = 0) => {
    // 버전을 먼저 읽는다: 읽은 뒤 목록이 바뀌면 확인할 때 서버가 409로 알려 준다
    const v = await api<{ version: number }>("/api/seller/queue/version");
    if (!v.ok) return setState({ kind: "error", status: v.status });
    const q = new URLSearchParams({ limit: String(PAGE), ...(append ? { offset: String(offset) } : {}) });
    if (filter.from) q.set("from", filter.from);
    if (filter.to) q.set("to", filter.to);
    if (filter.statuses.length !== 1 || filter.statuses[0] !== "PENDING_PAYMENT") q.set("status", filter.statuses.length ? filter.statuses.join(",") : "ALL");
    if (filter.term.trim()) { q.set("q", filter.term.trim()); q.set("searchBy", filter.searchBy); }
    const r = await api<{ deposits: Row[]; total: number; summary?: Summary; capabilities?: { depositorSearch: boolean } }>(`/api/seller/payments/deposits?${q}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setPicked([]);
    setState((prev) => ({ kind: "ok", rows: append && prev.kind === "ok" ? [...prev.rows, ...r.data.deposits.filter((x) => !prev.rows.some((old) => old.orderId === x.orderId))] : r.data.deposits, total: r.data.total, version: v.data.version, summary: r.data.summary, depositorSearch: r.data.capabilities?.depositorSearch === true }));
  }, []);
  useEffect(() => {
    void load({ from: "", to: "", statuses: ["PENDING_PAYMENT"], searchBy: "buyer", term: "" });
  }, [load]);
  useScrollRestore("seller-deposits", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok") return;
    setMore(true);
    await load(applied, true, state.rows.length);
    setMore(false);
  };

  const send = async () => {
    if (!confirm || state.kind !== "ok") return;
    setBusy(true);
    const r = await api<{ results: Result[] }>("/api/seller/payments/deposits/confirm", { method: "POST", body: { orderIds: confirm.map((x) => x.orderId), expectedVersion: state.version } });
    setBusy(false);
    setConfirm(null);
    if (!r.ok) {
      if (r.error === "conflict") {
        void load(applied);
        return setToast({ text: "목록이 바뀌었습니다. 다시 불러온 뒤 확인해 주십시오", neg: true });
      }
      return setToast({ text: r.message ?? "입금 확인을 하지 못했습니다. 다시 시도해 주십시오", neg: true });
    }
    const ok = r.data.results.filter((x) => x.result === "paid").length;
    const failed = r.data.results.find((x) => x.result !== "paid");
    const detail = failed && failed.result !== "paid" ? RESULT_TEXT[failed.result] : "";
    if (ok > 0 && !failed) setToast({ text: `${ok}건 입금 확인 · 주문대기(방송에서 개봉할 순서 목록)에 올라갔습니다` });
    else if (ok > 0) setToast({ text: `${ok}건 입금 확인 · ${r.data.results.length - ok}건은 확인하지 못했습니다 · ${detail}`, neg: true });
    else setToast({ text: detail, neg: true });
    void load(applied);
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
          <SearchRow label="검색"><div className="row" style={{ gap: 8, flexWrap: "wrap" }}><select className="inp" aria-label="검색 기준" value={searchBy} onChange={(e) => setSearchBy(e.target.value as typeof searchBy)}><option value="buyer">구매자</option><option value="amount">금액</option><option value="depositor" disabled={!canSearchDepositor}>입금자명</option></select><input className="inp" aria-label="검색어" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={searchBy === "depositor" && !canSearchDepositor ? "실제 입금자명 미수집 · 검색할 수 없음" : searchBy === "amount" ? "정확한 금액" : "검색어"} disabled={searchBy === "depositor" && !canSearchDepositor} />{searchBy === "depositor" && !canSearchDepositor && <span className="t-c1 c-alt">실제 입금자명을 수집하지 않아 검색할 수 없습니다</span>}</div></SearchRow>
        </SearchBox>

        <div className="card" style={{ overflow: "visible" }}>
          {state.kind === "ok" && (
            <ListHead
              total={state.total}
              actions={
                <>
                  {overdue > 0 && <span className="t-l2 c-alt">기한 지남 {overdue}건</span>}
                  <button className="btn btn-dense btn-w-xl" type="button" disabled={picked.length === 0} onClick={() => setConfirm(rows.filter((r) => picked.includes(r.orderId)))}>
                    선택 입금 확인{picked.length > 0 ? ` (${picked.length})` : ""}
                  </button>
                </>
              }
            />
          )}

          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문 · 배송" /> : state.status === 402 ? <Locked /> : <ErrorState title="입금 대기 주문을 불러오지 못했습니다" onRetry={() => void load(applied)} />)}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">입금 전 주문이 없습니다</span>
              <span className="s">무통장 주문이 들어오면 여기에 표시됩니다.</span>
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <div className="au-lt-wrap">
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
                    <th style={{ width: 136, whiteSpace: "nowrap" }}>입금 기한</th>
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
                        <td>{o.buyerName ? <span>주문자 실명 · {o.buyerName}</span> : o.depositorNameStatus === "NOT_COLLECTED" || o.depositorNameSource === "BUYER_MEMBER_NAME_LEGACY" ? <span className="t-c1 c-alt">실제 입금자명 미수집</span> : <span className="t-c1 c-alt">확인 정보 없음</span>}</td>
                        <td className="num">{won(o.amount)}</td>
                        <td>{o.paymentMethod === "BANK_TRANSFER" ? "무통장 입금" : o.paymentMethod === "CARD" ? "카드" : "선택 전"}</td>
                        <td className="num" style={{ width: 136, whiteSpace: "nowrap" }}>{o.paymentDueAt ? formatDateTime(o.paymentDueAt) : "-"}</td>
                        <td>{left.urgent ? <b style={{ color: "var(--neg, #c0262c)" }}>{left.text}</b> : left.text}</td>
                        <td>
                          {payable.some((r) => r.orderId === o.orderId) ? <button className="btn btn-sm btn-w-sm" type="button" onClick={() => setConfirm([o])}>입금 확인</button> : <span className="t-c1 c-alt">{stateLabel}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ok" && state.rows.length < state.total && (
            <div className="row dep-more">
              <button className={`btn btn-dense btn-out btn-level-secondary${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
                더 불러오기
              </button>
            </div>
          )}
        </div>
      </main>

      {confirm && (
        <Modal labelId="dep-title" busy={busy} onClose={() => setConfirm(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="dep-title">
              입금을 확인하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">
              {confirm.length === 1
                ? `${confirm[0].nickname}${confirm[0].buyerName ? ` · 주문자 실명 ${confirm[0].buyerName}` : ""} · ${won(confirm[0].amount)}. `
                : `${confirm.length}건 · 합계 ${won(confirm.reduce((s, x) => s + x.amount, 0))}. `}
              확인하면 주문대기에 올라가고 구매자에게 알림이 갑니다.
            </span>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setConfirm(null)} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void send()} disabled={busy}>
              {busy ? "확인 중" : "입금 확인"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
