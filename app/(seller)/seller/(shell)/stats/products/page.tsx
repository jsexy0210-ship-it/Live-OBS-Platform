"use client";

import { ListTable } from "../../../../../../components/admin-ui";

import Funnel from "../../../../../../components/seller/stats/Funnel";
import { EmptyStats, StatsFrame, StatsState, usePeriod, useStats } from "../../../../../../components/seller/stats/StatsFrame";
import { Kpis, count, downloadCsv, won } from "../../../../../../components/seller/stats/parts";

// SA-056 통계 · 상품(GET /api/seller/stats/products). 주문 시각(KST) 기간의 결제 완료 주문(환불 제외) 품목 기준.
type Row = { productId: string; name: string; deleted: boolean; quantity: number; revenue: number; orders: number };
type Totals = { quantity: number; revenue: number; products: number };
type Data = { range: { from: string; to: string }; current: Totals; previous: Totals; top: Row[]; unsold: { productId: string; name: string; status: string }[]; unsoldCount: number };

const STATUS: Record<string, string> = { ON_SALE: "판매 중", SOLD_OUT: "품절", HIDDEN: "숨김" };
const qty = (n: number) => `${n.toLocaleString("ko-KR")}개`;

export default function ProductStatsPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("products", period);
  const data = state.kind === "ok" ? state.data : null;
  const max = data ? Math.max(1, ...data.top.map((r) => r.revenue)) : 1;

  const download = () => {
    if (!data) return;
    downloadCsv(
      `product-stats_${data.range.from}_${data.range.to}.csv`,
      ["구분", "순위", "상품", "판매 수량", "매출", "주문 수"],
      [
        ...data.top.map((r, i) => ["판매 상품", i + 1, r.deleted ? `${r.name} (삭제됨)` : r.name, r.quantity, r.revenue, r.orders]),
        ...data.unsold.map((p) => ["안 팔린 상품", null, p.name, 0, 0, 0]),
      ],
    );
  };

  return (
    <StatsFrame title="상품" sub="주문 시각(KST) 기준, 결제 완료 주문의 상품입니다. 환불된 주문은 넣지 않습니다." period={period} setPeriod={setPeriod} units={false} onDownload={data ? download : undefined}>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && (
        <>
          <Kpis
            items={[
              { label: "판매 수량", now: data.current.quantity, prev: data.previous.quantity, fmt: qty },
              { label: "상품 매출", now: data.current.revenue, prev: data.previous.revenue, fmt: won },
              { label: "팔린 상품", now: data.current.products, prev: data.previous.products, fmt: (n) => `${n.toLocaleString("ko-KR")}종` },
              { label: "안 팔린 상품", now: data.unsoldCount, prev: null, fmt: (n) => `${n.toLocaleString("ko-KR")}종`, compare: false, note: "지금 판매 상태 기준" },
            ]}
          />
          {data.top.length === 0 ? (
            <EmptyStats text="선택한 기간에 팔린 상품이 없습니다" />
          ) : (
            <div className="au-list-section sts-scroll">
              <div className="sts-h">
                <span className="fw6">상위 상품</span>
                <span className="t-c1 c-alt">매출순 {data.top.length}개</span>
              </div>
              <ListTable>
<table className="tbl" data-testid="stats-top">
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>순위</th>
                    <th>상품</th>
                    <th>판매 수량</th>
                    <th>매출</th>
                    <th>주문 수</th>
                    <th aria-label="매출 비교" />
                  </tr>
                </thead>
                <tbody>
                  {data.top.map((r, i) => (
                    <tr key={r.productId}>
                      <td className="num">{i + 1}</td>
                      <td className="fw6 sts-name col-text">
                        {r.name}
                        {r.deleted && <span className="t-c1 c-alt"> · 삭제됨</span>}
                      </td>
                      <td className="num">{qty(r.quantity)}</td>
                      <td className="num fw6">{won(r.revenue)}</td>
                      <td className="num">{count(r.orders)}</td>
                      <td>
                        <span className="sts-share" aria-hidden="true">
                          <i style={{ width: `${Math.max(2, (r.revenue / max) * 100)}%` }} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
</ListTable>
            </div>
          )}
          <Funnel period={period} />
          <div className="au-list-section sts-scroll">
            <div className="sts-h">
              <span className="fw6">안 팔린 상품</span>
              <span className="t-c1 c-alt">임시 저장 상품은 빼고 센 값입니다 · {data.unsoldCount > data.unsold.length ? `먼저 등록한 ${data.unsold.length}개 표시` : `${data.unsoldCount}개`}</span>
            </div>
            {data.unsold.length === 0 ? (
              <div className="st" style={{ boxShadow: "none", minHeight: 120 }}>
                <span className="t">모든 상품이 팔렸습니다</span>
              </div>
            ) : (
              <ListTable>
<table className="tbl" data-testid="stats-unsold">
                <thead>
                  <tr>
                    <th>상품</th>
                    <th>판매 상태</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unsold.map((p) => (
                    <tr key={p.productId}>
                      <td className="col-text">{p.name}</td>
                      <td className="c-alt">{STATUS[p.status] ?? "확인 필요"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
</ListTable>
            )}
          </div>
        </>
      )}
    </StatsFrame>
  );
}
