"use client";

import { StatsFrame, StatsState, usePeriod, useStats, type Unit } from "../../../../../../components/seller/stats/StatsFrame";
import { BarChart, Kpis, bucketLabel, downloadCsv, pct } from "../../../../../../components/seller/stats/parts";

// SA-056 통계 · 회원(GET /api/seller/stats/members). 날짜는 KST.
type Summary = { signups: number; withdrawals: number; buyers: number; repeatBuyers: number; repeatRate: number | null };
type Point = { bucket: string; signups: number; withdrawals: number; buyers: number };
type Data = { range: { from: string; to: string; unit: Unit }; current: Summary; previous: Summary; series: Point[] };

const people = (n: number) => `${n.toLocaleString("ko-KR")}명`;

export default function MemberStatsPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("members", period);
  const data = state.kind === "ok" ? state.data : null;

  const download = () => {
    if (!data) return;
    downloadCsv(
      `member-stats_${data.range.from}_${data.range.to}.csv`,
      ["기간", "신규 가입", "구매 회원", "탈퇴"],
      data.series.map((p) => [p.bucket, p.signups, p.buyers, p.withdrawals]),
    );
  };

  return (
    <StatsFrame title="회원" sub="가입·탈퇴는 그 시각, 구매 회원은 결제 주문의 주문한 시각(한국 시간) 기준입니다." period={period} setPeriod={setPeriod} onDownload={data ? download : undefined}>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && (
        <>
          <Kpis
            items={[
              { label: "신규 가입", now: data.current.signups, prev: data.previous.signups, fmt: people },
              { label: "구매 회원", now: data.current.buyers, prev: data.previous.buyers, fmt: people },
              { label: "다시 산 회원 비율", now: data.current.repeatRate, prev: data.previous.repeatRate, fmt: (n) => pct(n), text: `${pct(data.current.repeatRate)} · ${people(data.current.repeatBuyers)}` },
              { label: "탈퇴", now: data.current.withdrawals, prev: data.previous.withdrawals, fmt: people, lowerIsBetter: true },
            ]}
          />
          <BarChart title="신규 가입" fmt={people} points={data.series.map((p) => ({ label: bucketLabel(p.bucket, data.range.unit), value: p.signups }))} />
          <div className="card sts-scroll">
            <table className="tbl" data-testid="stats-table">
              <thead>
                <tr>
                  <th>기간</th>
                  <th className="r">신규 가입</th>
                  <th className="r">구매 회원</th>
                  <th className="r">탈퇴</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((p) => (
                  <tr key={p.bucket} className={p.signups + p.buyers + p.withdrawals === 0 ? "faded" : ""}>
                    <td className="num">{bucketLabel(p.bucket, data.range.unit)}</td>
                    <td className="r num">{people(p.signups)}</td>
                    <td className="r num">{people(p.buyers)}</td>
                    <td className="r num">{people(p.withdrawals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="t-c1 c-alt">산 회원 중에서 이 기간에 2번 이상 결제한 회원의 비율입니다. 기간별 숫자를 더하면 합계와 다를 수 있습니다(같은 사람이 여러 기간에 나올 수 있기 때문입니다).</p>
        </>
      )}
    </StatsFrame>
  );
}
