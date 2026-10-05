"use client";

import "../../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { listTime } from "../../../../../../components/seller/orders";

// SA-026 입금 확인(파트너스 관리자, 주문 › 입금 확인). 무통장 입금 대기 주문을 기한 빠른 순으로 보고, 통장 내역과 맞춰 본 뒤 단건·일괄로 입금 확인한다.
// API: GET /api/seller/payments/deposits(입금 대기 목록), POST /api/seller/payments/deposits/confirm(확인 직전 /api/seller/queue/version 값을 함께 보냄).
// 확인에 보내는 expectedVersion은 목록을 불러올 때 함께 읽어 둔 값이다(보낸 사이 바뀌었으면 서버가 409로 막는다).
// 입금자명은 구매자 개인정보 열람 권한이 있을 때만 서버가 내려 준다.
const PAGE = 20;
type Row = { orderId: string; orderNo: number; amount: number; nickname: string; depositorName?: string; paymentMethod: "CARD" | "BANK_TRANSFER" | null; paymentDueAt: string | null; createdAt: string };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Row[]; total: number; version: number };
type Result = { orderId: string; result: "paid" | "stock_shortage" | "already_paid" | "card_in_progress" | "not_payable" | "not_found" };

const RESULT_TEXT: Record<Exclude<Result["result"], "paid">, string> = {
  stock_shortage: "재고가 부족해 확인하지 못했습니다",
  already_paid: "이미 입금 확인된 주문입니다",
  card_in_progress: "카드 결제가 진행 중인 주문입니다",
  not_payable: "입금 확인할 수 없는 주문입니다",
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

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    // 버전을 먼저 읽는다: 읽은 뒤 목록이 바뀌면 확인할 때 서버가 409로 알려 준다
    const v = await api<{ version: number }>("/api/seller/queue/version");
    if (!v.ok) return setState({ kind: "error", status: v.status });
    const r = await api<{ deposits: Row[]; total: number }>(`/api/seller/payments/deposits?limit=${PAGE}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setPicked([]);
    setState({ kind: "ok", rows: r.data.deposits, total: r.data.total, version: v.data.version });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (state.kind !== "ok") return;
    setMore(true);
    const r = await api<{ deposits: Row[]; total: number }>(`/api/seller/payments/deposits?limit=${PAGE}&offset=${state.rows.length}`);
    setMore(false);
    if (!r.ok) return setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
    const seen = new Set(state.rows.map((x) => x.orderId));
    setState({ ...state, rows: [...state.rows, ...r.data.deposits.filter((x) => !seen.has(x.orderId))], total: r.data.total });
  };

  const send = async () => {
    if (!confirm || state.kind !== "ok") return;
    setBusy(true);
    const r = await api<{ results: Result[] }>("/api/seller/payments/deposits/confirm", { method: "POST", body: { orderIds: confirm.map((x) => x.orderId), expectedVersion: state.version } });
    setBusy(false);
    setConfirm(null);
    if (!r.ok) {
      if (r.error === "conflict") {
        void load();
        return setToast({ text: "목록이 바뀌었습니다. 다시 불러온 뒤 확인해 주십시오", neg: true });
      }
      return setToast({ text: r.message ?? "입금 확인을 하지 못했습니다. 다시 시도해 주십시오", neg: true });
    }
    const ok = r.data.results.filter((x) => x.result === "paid").length;
    const failed = r.data.results.find((x) => x.result !== "paid");
    const detail = failed && failed.result !== "paid" ? RESULT_TEXT[failed.result] : "";
    if (ok > 0 && !failed) setToast({ text: `${ok}건 입금 확인 · 주문대기에 올라갔습니다` });
    else if (ok > 0) setToast({ text: `${ok}건 입금 확인 · ${r.data.results.length - ok}건은 확인하지 못했습니다 · ${detail}`, neg: true });
    else setToast({ text: detail, neg: true });
    void load();
  };

  const rows = state.kind === "ok" ? state.rows : [];
  const showName = rows.some((r) => r.depositorName !== undefined);
  const allPicked = rows.length > 0 && picked.length === rows.length;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const overdue = rows.filter((r) => r.paymentDueAt && new Date(r.paymentDueAt).getTime() <= now).length;

  return (
    <>
      <Topbar crumb="주문 › 입금 확인" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">입금 확인</h1>
            <span className="t-l2 c-alt">통장 내역과 입금자명 · 금액이 같은지 확인한 뒤 「입금 확인」을 누릅니다. 확인하면 주문대기에 올라갑니다.</span>
          </div>
          <Link className="btn btn-out" href="/seller/settings/order">
            주문 설정
          </Link>
        </div>

        <div className="card" style={{ overflow: "visible" }}>
          <div className="toolbar">
            <span className="t-l2 c-alt" aria-live="polite" data-testid="deposit-count">
              {state.kind === "ok" ? `입금 전 ${state.total}건${overdue > 0 ? ` · 기한 지남 ${overdue}건` : ""}` : ""}
            </span>
            <span style={{ marginLeft: "auto" }} />
            <button className="btn btn-sm" type="button" disabled={picked.length === 0} onClick={() => setConfirm(rows.filter((r) => picked.includes(r.orderId)))}>
              선택 입금 확인{picked.length > 0 ? ` (${picked.length})` : ""}
            </button>
          </div>

          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문 · 배송" /> : state.status === 402 ? <Locked /> : <ErrorState title="입금 대기 주문을 불러오지 못했습니다" onRetry={() => void load()} />)}
          {state.kind === "ok" && rows.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">입금 전 주문이 없습니다</span>
              <span className="s">무통장 주문이 들어오면 여기에 표시됩니다.</span>
            </div>
          )}
          {state.kind === "ok" && rows.length > 0 && (
            <div className="ord-scroll">
              <table className="tbl ord-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input className="cbx" type="checkbox" aria-label="전체 선택" checked={allPicked} onChange={() => setPicked(allPicked ? [] : rows.map((r) => r.orderId))} />
                    </th>
                    <th>주문</th>
                    {showName && <th>입금자명</th>}
                    <th className="r">금액</th>
                    <th>결제 방식</th>
                    <th>입금 기한</th>
                    <th>남은 시간</th>
                    <th style={{ width: 110 }} aria-label="작업" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => {
                    const left = remaining(o.paymentDueAt, now);
                    return (
                      <tr key={o.orderId} data-testid="deposit-row">
                        <td>
                          <input className="cbx" type="checkbox" aria-label={`${o.nickname} 선택`} checked={picked.includes(o.orderId)} onChange={() => toggle(o.orderId)} />
                        </td>
                        <td>
                          <Link href={`/seller/orders/${o.orderId}`} className="fw6 ord-link">
                            {o.nickname}
                          </Link>
                          <div className="t-c1 c-alt num">{listTime(o.createdAt)} 주문</div>
                        </td>
                        {showName && <td>{o.depositorName ?? "-"}</td>}
                        <td className="r num">{won(o.amount)}</td>
                        <td>{o.paymentMethod === "BANK_TRANSFER" ? "무통장 입금" : o.paymentMethod === "CARD" ? "카드" : "선택 전"}</td>
                        <td className="num">{o.paymentDueAt ? listTime(o.paymentDueAt) : "-"}</td>
                        <td>{left.urgent ? <b style={{ color: "var(--neg, #c0262c)" }}>{left.text}</b> : left.text}</td>
                        <td>
                          <button className="btn btn-sm" type="button" onClick={() => setConfirm([o])}>
                            입금 확인
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ok" && state.rows.length < state.total && (
            <div className="row" style={{ padding: "12px 20px", justifyContent: "center" }}>
              <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
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
                ? `${confirm[0].nickname}${confirm[0].depositorName ? ` · 입금자명 ${confirm[0].depositorName}` : ""} · ${won(confirm[0].amount)}. `
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
