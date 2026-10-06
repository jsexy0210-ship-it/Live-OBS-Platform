"use client";

import { ListTable } from "../../../../../../components/admin-ui";

import { EmptyStats, StatsFrame, StatsState, usePeriod, useStats, type Unit } from "../../../../../../components/seller/stats/StatsFrame";
import { BarChart, Kpis, bucketLabel, count, downloadCsv, won } from "../../../../../../components/seller/stats/parts";

// SA-056 통계 · 매출(GET /api/seller/stats/sales). 주문 시각(KST) 기준, 결제된 주문만.
type Summary = { gross: number; discount: number; couponDiscount: number; rewardUsed: number; shippingFee: number; paid: number; refund: number; net: number; paidOrders: number };
type Method = { method: string; paidOrders: number; paid: number; refund: number; net: number };
type Point = { bucket: string; paid: number; refund: number; net: number };
type Data = { range: { from: string; to: string; unit: Unit }; current: Summary; previous: Summary; byMethod: Method[]; series: Point[] };

const METHOD_LABEL: Record<string, string> = { CARD: "카드", BANK_TRANSFER: "무통장 입금", OTHER: "기타" };

export default function SalesStatsPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("sales", period);
  const data = state.kind === "ok" ? state.data : null;

  const download = () => {
    if (!data) return;
    const c = data.current;
    downloadCsv(
      `sales-stats_${data.range.from}_${data.range.to}.csv`,
      ["구분", "항목", "결제 주문", "결제 금액", "환불 금액", "실제 매출"],
      [
        ["합계", "할인 전 판매 금액", null, c.gross, null, null],
        ["합계", "할인", null, -c.discount, null, null],
        ["합계", "쿠폰 할인", null, -c.couponDiscount, null, null],
        ["합계", "적립금 사용", null, -c.rewardUsed, null, null],
        ["합계", "배송비", null, c.shippingFee, null, null],
        ["합계", "전체", c.paidOrders, c.paid, c.refund, c.net],
        ...data.byMethod.map((m) => ["결제 방법", METHOD_LABEL[m.method] ?? "기타", m.paidOrders, m.paid, m.refund, m.net]),
        ...data.series.map((p) => ["기간", p.bucket, null, p.paid, p.refund, p.net]),
      ],
    );
  };

  return (
    <StatsFrame title="매출" sub="주문한 시각(한국 시간) 기준, 결제된 주문의 금액입니다. 결제 대기·취소 주문은 넣지 않습니다." period={period} setPeriod={setPeriod} onDownload={data ? download : undefined}>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && data.current.paidOrders === 0 && <EmptyStats text="선택한 기간에 결제된 주문이 없습니다" />}
      {data && data.current.paidOrders > 0 && (
        <>
          <Kpis
            items={[
              { label: "할인 전 판매 금액", now: data.current.gross, prev: data.previous.gross, fmt: won },
              { label: "결제 금액", now: data.current.paid, prev: data.previous.paid, fmt: won },
              { label: "환불 금액", now: data.current.refund, prev: data.previous.refund, fmt: won, lowerIsBetter: true },
              { label: "실제 매출(환불 뺀 금액)", now: data.current.net, prev: data.previous.net, fmt: won },
            ]}
          />
          <BarChart title="실제 매출" fmt={won} points={data.series.map((p) => ({ label: bucketLabel(p.bucket, data.range.unit), value: Math.max(0, p.net) }))} />
          <div className="card sts-scroll">
            <div className="sts-h">
              <span className="fw6">매출 구성</span>
            </div>
            <table className="tbl" data-testid="stats-breakdown">
              <tbody>
                <tr>
                  <td>할인 전 판매 금액</td>
                  <td className="r num">{won(data.current.gross)}</td>
                </tr>
                <tr>
                  <td>할인</td>
                  <td className="r num">−{won(data.current.discount)}</td>
                </tr>
                <tr>
                  <td>쿠폰 할인</td>
                  <td className="r num">−{won(data.current.couponDiscount)}</td>
                </tr>
                <tr>
                  <td>적립금 사용</td>
                  <td className="r num">−{won(data.current.rewardUsed)}</td>
                </tr>
                <tr>
                  <td>배송비</td>
                  <td className="r num">+{won(data.current.shippingFee)}</td>
                </tr>
                <tr>
                  <td className="fw6">결제 금액</td>
                  <td className="r num fw6">{won(data.current.paid)}</td>
                </tr>
                <tr>
                  <td>환불 금액</td>
                  <td className="r num">−{won(data.current.refund)}</td>
                </tr>
                <tr>
                  <td className="fw6">실제 매출(환불 뺀 금액)</td>
                  <td className="r num fw6">{won(data.current.net)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="au-list-section sts-scroll">
            <div className="sts-h">
              <span className="fw6">결제 방법별</span>
            </div>
            <ListTable>
<table className="tbl" data-testid="stats-methods">
              <thead>
                <tr>
                  <th>결제 방법</th>
                  <th className="r">결제 주문</th>
                  <th className="r">결제 금액</th>
                  <th className="r">환불 금액</th>
                  <th className="r">실제 매출</th>
                </tr>
              </thead>
              <tbody>
                {data.byMethod.map((m) => (
                  <tr key={m.method}>
                    <td>{METHOD_LABEL[m.method] ?? "기타"}</td>
                    <td className="r num">{count(m.paidOrders)}</td>
                    <td className="r num">{won(m.paid)}</td>
                    <td className="r num">{won(m.refund)}</td>
                    <td className="r num fw6">{won(m.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
</ListTable>
          </div>
          <ListTable>
            <table className="tbl" data-testid="stats-table">
              <thead>
                <tr>
                  <th>기간</th>
                  <th className="r">결제 금액</th>
                  <th className="r">환불 금액</th>
                  <th className="r">실제 매출</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((p) => (
                  <tr key={p.bucket} className={p.paid === 0 ? "faded" : ""}>
                    <td className="num">{bucketLabel(p.bucket, data.range.unit)}</td>
                    <td className="r num">{won(p.paid)}</td>
                    <td className="r num">{won(p.refund)}</td>
                    <td className="r num fw6">{won(p.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ListTable>
        </>
      )}
    </StatsFrame>
  );
}
