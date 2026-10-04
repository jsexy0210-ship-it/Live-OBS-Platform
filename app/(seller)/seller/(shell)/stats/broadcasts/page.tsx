"use client";

import { EmptyStats, StatsFrame, StatsState, usePeriod, useStats } from "../../../../../../components/seller/stats/StatsFrame";
import { BarChart, Kpis, count, downloadCsv, won } from "../../../../../../components/seller/stats/parts";

// 방송 통계(GET /api/seller/stats/broadcasts). 기간(KST)에 시작한 방송별 주문대기 주문 기준.
type Row = { id: string; title: string | null; status: string; startedAt: string; endedAt: string | null; orders: number; paid: number; refunded: number; refund: number; net: number };
type Data = { range: { from: string; to: string }; total: { broadcasts: number; orders: number; paid: number; net: number }; broadcasts: Row[] };

const kst = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}.${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const name = (r: Row) => r.title?.trim() || `${kst(r.startedAt)} 방송`;

export default function BroadcastStatsPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("broadcasts", period);
  const data = state.kind === "ok" ? state.data : null;

  const download = () => {
    if (!data) return;
    downloadCsv(
      `broadcast-stats_${data.range.from}_${data.range.to}.csv`,
      ["방송", "시작(KST)", "종료(KST)", "주문 수", "결제액", "환불", "환불액", "순매출"],
      data.broadcasts.map((r) => [name(r), kst(r.startedAt), r.endedAt ? kst(r.endedAt) : null, r.orders, r.paid, r.refunded, r.refund, r.net]),
    );
  };
  // 그래프는 오래된 방송부터
  const chrono = data ? [...data.broadcasts].reverse() : [];

  return (
    <StatsFrame title="방송" sub="기간 중 시작한 방송별로, 주문대기에 올라간 결제 주문을 셉니다." period={period} setPeriod={setPeriod} units={false} onDownload={data ? download : undefined}>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && data.total.broadcasts === 0 && <EmptyStats text="선택한 기간에 진행한 방송이 없습니다" />}
      {data && data.total.broadcasts > 0 && (
        <>
          <Kpis
            items={[
              { label: "방송 수", now: data.total.broadcasts, prev: null, fmt: (n) => `${n.toLocaleString("ko-KR")}회`, compare: false },
              { label: "방송 주문", now: data.total.orders, prev: null, fmt: count, compare: false },
              { label: "방송 순매출", now: data.total.net, prev: null, fmt: won, compare: false },
              { label: "시청자 → 주문 전환", now: null, prev: null, fmt: String, text: "준비 중", compare: false, note: "시청 데이터 연동 뒤 제공" },
            ]}
          />
          <BarChart title="방송별 순매출" fmt={won} points={chrono.map((r) => ({ label: kst(r.startedAt).split(" ")[0], value: Math.max(0, r.net) }))} />
          <div className="card sts-scroll">
            <table className="tbl" data-testid="stats-broadcasts">
              <thead>
                <tr>
                  <th>방송</th>
                  <th>시작</th>
                  <th className="r">주문 수</th>
                  <th className="r">결제액</th>
                  <th className="r">환불액</th>
                  <th className="r">순매출</th>
                  <th className="r">시청자 수</th>
                </tr>
              </thead>
              <tbody>
                {data.broadcasts.map((r) => (
                  <tr key={r.id} className={r.orders === 0 ? "faded" : ""}>
                    <td className="fw6 sts-name">
                      {name(r)}
                      {r.status === "LIVE" && <span className="bdg b-info nodot" style={{ marginLeft: 6 }}>방송 중</span>}
                    </td>
                    <td className="num">{kst(r.startedAt)}</td>
                    <td className="r num">{count(r.orders)}</td>
                    <td className="r num">{won(r.paid)}</td>
                    <td className="r num">{won(r.refund)}</td>
                    <td className="r num fw6">{won(r.net)}</td>
                    <td className="r sts-soon">준비 중</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-c1 c-alt">시청자 수와 시청자 → 주문 전환은 시청 데이터 연동 뒤 제공합니다.</p>
        </>
      )}
    </StatsFrame>
  );
}
