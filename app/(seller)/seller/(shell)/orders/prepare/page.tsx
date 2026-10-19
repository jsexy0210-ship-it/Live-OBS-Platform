"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ListTable, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission } from "../../../../../../components/seller/States";
import { PrepareShipping } from "../../../../../../components/seller/OrderWork";
import { api } from "../../../../../../components/seller/api";
import { type OrderDetail } from "../../../../../../components/seller/orders";

function SelectedOrderWork({ requestKey }: { requestKey: string }) {
  const { can, me } = useSeller();
  const key = requestKey;
  const ids = useMemo(() => [...new Set(key.split(",").map((id) => id.toLowerCase()))], [key]);
  const valid = ids.length > 0 && ids.length <= 100 && ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const allowed = can("ORDER_SHIPPING") && !me.readOnly;
  const generation = useRef(0);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; orders: OrderDetail[]; missing: number }>({ kind: "loading" });
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!allowed || !valid) return;
    const responses = await Promise.all(ids.map((id) => api<OrderDetail>(`/api/seller/orders/${id}`)));
    if (request !== generation.current) return;
    const failed = responses.find((r) => !r.ok && r.status !== 404);
    if (failed && !failed.ok) return setState({ kind: "error", status: failed.status });
    setState({ kind: "ok", orders: responses.flatMap((r) => r.ok ? [r.data] : []), missing: responses.filter((r) => !r.ok && r.status === 404).length });
  }, [allowed, valid, ids]);
  useEffect(() => { setState({ kind: "loading" }); void load(); return () => { generation.current++; }; }, [load]);
  return <><Topbar crumb="판매 › 주문 › 선택 주문 배송 준비" /><main className="main">
    <PageHead title="선택 주문 배송 준비" back="/seller/orders" />
    {!allowed ? <NoPermission need="주문·배송" /> : !valid ? <div className="card pad">작업할 주문을 목록에서 다시 선택해 주십시오.</div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={4} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="주문·배송" /> : <div className="card"><ErrorState title="선택한 주문을 불러오지 못했습니다" onRetry={() => void load()} /></div> : <>
      <section className="au-list-section" aria-label="선택한 주문">
        {state.missing > 0 && <p role="status">찾을 수 없는 주문 {state.missing}건 · 남은 주문 {state.orders.length}건</p>}
        <p>선택한 {state.orders.length}건에만 적용합니다. 바꿀 수 없는 주문은 서버가 건너뜁니다.</p>
        <ListTable><table className="tbl"><thead><tr><th>주문번호</th><th>구매자</th><th>배송 준비</th></tr></thead><tbody>{state.orders.map((order) => <tr key={order.id}><td><Link href={`/seller/orders/${order.id}`}>{order.orderNoLabel}</Link></td><td>{order.buyer.broadcastNickname}</td><td>{order.shippingPreparedAt ? "배송 준비" : "변경 전"}</td></tr>)}</tbody></table></ListTable>
      </section>
      <PrepareShipping key={key} ids={state.orders.map((order) => order.id)} onDone={() => void load()} />
    </>}
  </main></>;
}

function SelectedOrders() {
  const query = useSearchParams();
  const ids = query.get("ids") ?? "";
  return <SelectedOrderWork key={ids} requestKey={ids} />;
}

export default function PrepareOrdersPage() {
  return <Suspense><SelectedOrders /></Suspense>;
}
