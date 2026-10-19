"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ListTable, PageHead } from "../../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../../../components/seller/States";
import { SmartBackButton } from "../../../../../../../components/seller/SmartBackButton";
import { api } from "../../../../../../../components/seller/api";
import { won } from "../../../../../../../components/seller/format";
import type { OrderDetail } from "../../../../../../../components/seller/orders";

type Result = { orderId: string; result: "paid" | "stock_shortage" | "already_paid" | "card_in_progress" | "not_payable" | "not_found" };

const RESULT_TEXT: Record<Exclude<Result["result"], "paid">, string> = {
  stock_shortage: "재고가 부족해 입금 확인을 하지 못했습니다. 재고를 늘린 뒤 다시 눌러 주십시오.",
  already_paid: "이미 입금 확인된 주문입니다",
  card_in_progress: "카드 결제가 진행 중입니다. 잠시 뒤 다시 확인해 주십시오.",
  not_payable: "입금 확인을 할 수 없는 주문입니다. 주문 상세에서 상태를 확인해 주십시오.",
  not_found: "주문을 찾지 못했습니다",
};

type Deposit = { orderId: string; nickname: string; buyerName?: string; amount: number; status: string };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: Deposit[]; version: number };

function Confirmation({ requestKey }: { requestKey: string }) {
  const { can, me } = useSeller();
  const allowed = can("ORDER_SHIPPING") && !me.readOnly;
  const ids = useMemo(() => [...new Set(requestKey.split(",").map((id) => id.toLowerCase()))], [requestKey]);
  const valid = ids.length > 0 && ids.length <= 50 && ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const load = useCallback(async () => {
    if (!allowed || !valid) return;
    setState({ kind: "loading" });
    const version = await api<{ version: number }>("/api/seller/queue/version");
    if (!version.ok) return setState({ kind: "error", status: version.status });
    const orders = await Promise.all(ids.map((id) => api<OrderDetail & { broadcastNicknameSnapshot: string }>(`/api/seller/orders/${id}`)));
    const failed = orders.find((r) => !r.ok);
    if (failed && !failed.ok) return setState({ kind: "error", status: failed.status });
    setState({ kind: "ok", version: version.data.version, rows: orders.flatMap((r) => r.ok ? [{ orderId: r.data.id, nickname: r.data.broadcastNicknameSnapshot, buyerName: r.data.buyer.name, amount: r.data.totalAmount, status: r.data.status }] : []) });
  }, [allowed, valid, ids]);
  useEffect(() => { void load(); }, [load]);
  const send = async () => {
    if (busy || state.kind !== "ok") return;
    const confirm = state.rows;
    setBusy(true);
    const r = await api<{ results: Result[] }>("/api/seller/payments/deposits/confirm", { method: "POST", body: { orderIds: confirm.map((x) => x.orderId), expectedVersion: state.version } });
    setBusy(false);
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
    if (ok > 0 && !failed) setToast({ text: `${ok}건 입금 확인 · 주문대기(방송에서 개봉할 순서 목록)에 올라갔습니다` });
    else if (ok > 0) setToast({ text: `${ok}건 입금 확인 · ${r.data.results.length - ok}건은 확인하지 못했습니다 · ${detail}`, neg: true });
    else setToast({ text: detail, neg: true });
    void load();
  };


  return <><Topbar crumb="주문 › 입금 확인 › 상세" /><main className="main">
    <PageHead title="입금 확인 상세" back="/seller/orders/deposits" />
    {!allowed ? <NoPermission need="주문 · 배송" /> : !valid ? <div className="card pad">작업할 주문을 목록에서 다시 선택해 주십시오.</div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={3} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="주문 · 배송" /> : <div className="card"><ErrorState title="선택한 주문을 불러오지 못했습니다" onRetry={() => void load()} /></div> : <section className="card pad col" style={{ gap: 16 }} aria-labelledby="dep-title">
      <h2 id="dep-title">입금을 확인하시겠습니까?</h2>
      <p>{state.rows.length}건 · 합계 {won(state.rows.reduce((s, x) => s + x.amount, 0))}. 확인하면 주문대기에 올라가고 구매자에게 알림이 갑니다.</p>
      <p>실제 입금자명은 수집하지 않습니다. 통장 내역에서 직접 확인한 뒤에만 「입금 확인」을 눌러 주십시오.</p>
      <ListTable><table className="tbl"><thead><tr><th>주문</th><th>구매자</th><th>주문자 실명</th><th>금액</th><th>입금 상태</th></tr></thead><tbody>{state.rows.map((row) => <tr key={row.orderId}><td><Link href={`/seller/orders/${row.orderId}`}>주문 상세</Link></td><td>{row.nickname}</td><td>{row.buyerName ?? "—"}</td><td>{won(row.amount)}</td><td>{row.status === "PAID" ? "입금 확인" : row.status === "PENDING_PAYMENT" ? "입금 대기" : "확인할 수 없음"}</td></tr>)}</tbody></table></ListTable>
      <button className="btn" type="button" onClick={() => void send()} disabled={busy}>{busy ? "확인 중" : "입금 확인"}</button>
    </section>}
    <SmartBackButton fallback="/seller/orders/deposits">목록으로</SmartBackButton>
  </main>{toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}</>;
}
function SelectedDeposits() { const query = useSearchParams(); const ids = query.get("ids") ?? ""; return <Confirmation key={ids} requestKey={ids} />; }
export default function DepositConfirmationPage() { return <Suspense><SelectedDeposits /></Suspense>; }
