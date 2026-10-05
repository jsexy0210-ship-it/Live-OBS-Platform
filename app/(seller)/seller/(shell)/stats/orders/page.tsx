"use client";

import { EmptyStats, StatsFrame, StatsState, usePeriod, useStats, type Unit } from "../../../../../../components/seller/stats/StatsFrame";
import { BarChart, Kpis, bucketLabel, count, downloadCsv, pct, won } from "../../../../../../components/seller/stats/parts";

// SA-056 통계 · 주문(GET /api/seller/stats/orders). 주문 시각(KST) 기준, 비교는 바로 앞 같은 기간.
type Summary = {
  orders: number;
  paidOrders: number;
  revenue: number;
  averageOrderValue: number | null;
  cancelled: number;
  cancelRate: number | null;
  refunded: number;
  refundRate: number | null;
  refundAmount: number;
  netRevenue: number;
};
type Point = { bucket: string; orders: number; paidOrders: number; revenue: number; cancelled: number; refunded: number; refundAmount: number; netRevenue: number };
type Data = { range: { from: string; to: string; unit: Unit }; current: Summary; previous: Summary; series: Point[] };

export default function OrderStatsPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("orders", period);
  const data = state.kind === "ok" ? state.data : null;

  const download = () => {
    if (!data) return;
    downloadCsv(
      `order-stats_${data.range.from}_${data.range.to}.csv`,
      ["기간", "주문 수", "결제 주문", "결제 금액", "취소", "환불", "환불 금액", "실제 매출"],
      data.series.map((p) => [p.bucket, p.orders, p.paidOrders, p.revenue, p.cancelled, p.refunded, p.refundAmount, p.netRevenue]),
    );
  };

  return (
    <StatsFrame title="주문" sub="주문한 시각(한국 시간) 기준입니다. 비교는 바로 앞 같은 일수의 기간과 합니다." period={period} setPeriod={setPeriod} onDownload={data ? download : undefined}>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && data.current.orders === 0 && <EmptyStats text="선택한 기간에 주문이 없습니다" />}
      {data && data.current.orders > 0 && (
        <>
          <Kpis
            items={[
              { label: "주문 수", now: data.current.orders, prev: data.previous.orders, fmt: count },
              { label: "결제 금액", now: data.current.revenue, prev: data.previous.revenue, fmt: won },
              { label: "주문 1건당 평균 금액", now: data.current.averageOrderValue, prev: data.previous.averageOrderValue, fmt: won },
              { label: "실제 매출", now: data.current.netRevenue, prev: data.previous.netRevenue, fmt: won },
              { label: "결제 전 취소", now: data.current.cancelled, prev: data.previous.cancelled, fmt: count, lowerIsBetter: true, text: `${count(data.current.cancelled)} · ${pct(data.current.cancelRate)}` },
              { label: "결제 후 환불", now: data.current.refunded, prev: data.previous.refunded, fmt: count, lowerIsBetter: true, text: `${count(data.current.refunded)} · ${pct(data.current.refundRate)}` },
            ]}
          />
          <BarChart title="주문 수" fmt={count} points={data.series.map((p) => ({ label: bucketLabel(p.bucket, data.range.unit), value: p.orders }))} />
          <div className="card sts-scroll">
            <table className="tbl" data-testid="stats-table">
              <thead>
                <tr>
                  <th>기간</th>
                  <th className="r">주문 수</th>
                  <th className="r">결제 주문</th>
                  <th className="r">결제 금액</th>
                  <th className="r">결제 전 취소</th>
                  <th className="r">결제 후 환불</th>
                  <th className="r">환불 금액</th>
                  <th className="r">실제 매출</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((p) => (
                  <tr key={p.bucket} className={p.orders === 0 ? "faded" : ""}>
                    <td className="num">{bucketLabel(p.bucket, data.range.unit)}</td>
                    <td className="r num">{count(p.orders)}</td>
                    <td className="r num">{count(p.paidOrders)}</td>
                    <td className="r num">{won(p.revenue)}</td>
                    <td className="r num">{count(p.cancelled)}</td>
                    <td className="r num">{count(p.refunded)}</td>
                    <td className="r num">{won(p.refundAmount)}</td>
                    <td className="r num fw6">{won(p.netRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-c1 c-alt">결제 금액은 결제된 주문(환불한 주문 포함)의 금액이고, 실제 매출은 결제 금액에서 환불 금액을 뺀 값입니다. 결제 전 취소와 결제 후 환불은 따로 셉니다.</p>
        </>
      )}
    </StatsFrame>
  );
}
