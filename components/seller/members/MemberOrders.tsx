"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { won } from "../format";
import { STATUS_BADGE, itemSummaryText, listDate, listTime, type OrderRow } from "../orders";

// SA-042 회원 상세의 주문 목록(이 회원의 주문만, 최신순). API: GET /api/seller/orders?memberId=&limit=&cursor=(주문·배송 권한 또는 후속 처리 권한).
// 행을 누르면 주문 상세(SA-022)로 간다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; rows: OrderRow[]; next: string | null };
const PAGE = 10;

export function MemberOrders({ memberId }: { memberId: string }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ orders: OrderRow[]; nextCursor: string | null }>(`/api/seller/orders?memberId=${memberId}&limit=${PAGE}`);
    setState(r.ok ? { kind: "ok", rows: r.data.orders, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, [memberId]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    setMoreFailed(false);
    const r = await api<{ orders: OrderRow[]; nextCursor: string | null }>(`/api/seller/orders?memberId=${memberId}&limit=${PAGE}&cursor=${encodeURIComponent(state.next)}`);
    setMore(false);
    if (!r.ok) return setMoreFailed(true);
    setState({ kind: "ok", rows: [...state.rows, ...r.data.orders], next: r.data.nextCursor });
  };

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-orders-title">
      <h2 className="t-hl1" id="member-orders-title">
        주문
      </h2>
      {state.kind === "loading" && <span className="t-l2 c-alt">불러오는 중입니다</span>}
      {state.kind === "error" &&
        (state.status === 403 ? (
          <span className="t-l2 c-alt">주문 목록은 주문 · 배송 권한이 있어야 볼 수 있습니다.</span>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            <span className="t-l2 c-alt">주문을 불러오지 못했습니다.</span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ))}
      {state.kind === "ok" && state.rows.length === 0 && <span className="t-l2" data-testid="member-orders-empty">주문 내역이 없습니다</span>}
      {state.kind === "ok" && state.rows.length > 0 && (
        <div className="au-lt-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>접수 시각</th>
                <th>상품</th>
                <th>금액</th>
                <th>결제</th>
                <th style={{ width: 80 }} aria-label="작업" />
              </tr>
            </thead>
            <tbody>
              {state.rows.map((o) => (
                <tr key={o.id} data-testid="member-order-row">
                  <td className="num">
                    {listTime(o.createdAt)}
                    <div className="t-c1 c-alt">{listDate(o.createdAt)}</div>
                  </td>
                  <td className="col-text ell">{itemSummaryText(o.itemSummary)}</td>
                  <td className="num">{won(o.totalAmount)}</td>
                  <td>
                    <span className={`bdg ${STATUS_BADGE[o.status].cls}`}>{STATUS_BADGE[o.status].label}</span>
                  </td>
                  <td>
                    <Link className="btn btn-sm btn-out" href={`/seller/orders/${o.id}`}>
                      상세
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state.kind === "ok" && state.next && (
        <div className="row" style={{ justifyContent: "center", gap: 8 }}>
          <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
            더 불러오기
          </button>
          {moreFailed && <span className="err">더 불러오지 못했습니다. 다시 눌러 주십시오</span>}
        </div>
      )}
    </section>
  );
}
