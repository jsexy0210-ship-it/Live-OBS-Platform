"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { listTime } from "../../../../../../components/seller/orders";

// SA-017 재입고 알림(파트너스 관리자, 상품 › 재입고 알림). 품절 상품에 구매자가 건 알림 신청을 상품별 수로 본다.
// API: GET /api/seller/restock-alerts(PRODUCT_MANAGE). 신청한 회원은 서버가 내려 주지 않는다.
// 재고가 들어오면 대기 → 발송 대기(밤 9시~아침 8시에 들어오면 아침 8시로 미룸) → 발송 순으로 바뀐다.
// 지금은 실제 알림 발송이 연결되지 않아 발송 기록만 남는다. 설정 값을 주고받는 API가 없어 설정 영역은 두지 않았다.
type Item = { productId: string; name: string; soldOut: boolean; waiting: number; queued: number; sent: number; nextNotifyAt: string | null; lastNotifiedAt: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: Item[] };

export default function RestockAlertsPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });

  const load = useCallback(async () => {
    const r = await api<{ items: Item[] }>("/api/seller/restock-alerts");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", items: r.data.items });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = state.kind === "ok" ? state.items : [];
  const waitingTotal = items.reduce((s, x) => s + x.waiting, 0);

  return (
    <>
      <Topbar crumb="상품 › 재입고 알림" />
      <main className="main">
        <PageHead title="재입고 알림" />
        {state.kind === "ok" && (
          <div className="msg msg-info" role="status">
            <span>재고가 들어오면 신청한 구매자에게 알림이 갑니다. 밤 9시부터 아침 8시 사이에 들어온 재고는 아침 8시에 보냅니다. 지금은 알림 발송이 연결되지 않아 발송 기록만 남습니다.</span>
          </div>
        )}
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="상품 관리" /> : state.status === 402 ? <Locked /> : <ErrorState title="재입고 알림을 불러오지 못했습니다" onRetry={() => void load()} />)}
          {state.kind === "ok" && items.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">0</div>
              <span className="t">재입고 알림 신청이 없습니다</span>
              <span className="s">구매자가 품절 상품에서 알림을 신청하면 여기에 상품별 수가 표시됩니다.</span>
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <>
              <div className="au-lt-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>상품</th>
                      <th>재고</th>
                      <th>대기</th>
                      <th>발송 대기</th>
                      <th>발송</th>
                      <th>다음 발송 예정</th>
                      <th>마지막 발송</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((x) => (
                      <tr key={x.productId} data-testid="restock-row">
                        <td className="col-text">
                          <Link href={`/seller/products/${x.productId}`} className="fw6">
                            {x.name}
                          </Link>
                        </td>
                        <td>{x.soldOut ? <span className="bdg b-warn">품절</span> : <span className="bdg b-done">판매 가능</span>}</td>
                        <td className="num">{x.waiting.toLocaleString("ko-KR")}명</td>
                        <td className="num">{x.queued.toLocaleString("ko-KR")}명</td>
                        <td className="num">{x.sent.toLocaleString("ko-KR")}명</td>
                        <td className="num">{x.nextNotifyAt ? listTime(x.nextNotifyAt) : "-"}</td>
                        <td className="num">{x.lastNotifiedAt ? listTime(x.lastNotifiedAt) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="t-c1 c-alt" style={{ padding: "12px 20px" }}>
                재고를 기다리는 구매자 {waitingTotal.toLocaleString("ko-KR")}명 · 신청한 구매자 정보는 표시하지 않습니다
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}
