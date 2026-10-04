"use client";

import Link from "next/link";
import { EmptyStats, StatsFrame, StatsState, usePeriod, useStats, type Unit } from "../../../../../components/seller/stats/StatsFrame";
import { overviewHasData } from "../../../../../components/seller/stats/overview";
import { BarChart, bucketLabel, count, downloadCsv, pct, won } from "../../../../../components/seller/stats/parts";

// SA-056 통계(요약). GET /api/seller/stats/overview 한 번으로 요약 지표·일별 매출·방송별 매출·상품별 판매·회원·적립금·주문 처리를 그린다.
// 데이터가 없는 지표(방문자·교환·반품·문의 답변·리뷰·회원 등급별)는 가짜 값 없이 「준비 중」으로 둔다.
type Kpi = { revenue: number; orders: number; excluded: number; averageOrderValue: number | null; signups: number; buyers: number };
type Product = { productId: string; name: string; deleted: boolean; quantity: number; revenue: number; orders: number };
type Data = {
  range: { from: string; to: string; unit: Unit; previous: { from: string; to: string } };
  summary: { current: Kpi; previous: Kpi };
  series: { bucket: string; revenue: number; orders: number }[];
  broadcasts: {
    rows: { id: string; title: string | null; startedAt: string; orders: number; net: number; hits: number }[];
    general: { orders: number; net: number };
    outside: { orders: number; net: number };
  };
  products: { top: Product[]; topByQuantity: Product[]; total: { quantity: number; revenue: number; products: number }; unsoldCount: number };
  coupons: { used: number; discount: number };
  members: { repeatRate: number | null; repeatBuyers: number; buyers: number; newNet: number; returningNet: number };
  rewards: { earned: number; revoked: number; used: number; expired: number; useRate: number | null };
  operations: {
    shipping: { shipped: number; avgHours: number | null };
    autoCancelled: number;
    autoCancelRate: number | null;
    cancelled: number;
    refunded: number;
    refundAmount: number;
  };
};

const SOON = "준비 중";
const PRODUCT_ROWS = 5;
const people = (n: number) => `${n.toLocaleString("ko-KR")}명`;
const md = (d: string) => d.slice(5).replace("-", "/").replace(/^0/, "").replace("/0", "/");
const hours = (h: number | null) => (h === null ? "—" : h >= 24 ? `${Math.round((h / 24) * 10) / 10}일` : `${h}시간`);

// 직전 기간 대비 한 줄. 비교를 끄면 줄 자체를 그리지 않는다
function cmpLine(on: boolean, now: number | null, prev: number | null, fmt: (n: number) => string, lowerIsBetter?: boolean) {
  if (!on) return null;
  if (now === null || prev === null) return <span className="d">직전 기간 —</span>;
  if (prev === 0) return <span className="d">직전 기간 {fmt(0)}</span>;
  const r = (now - prev) / Math.abs(prev);
  if (r === 0) return <span className="d">직전 기간과 같음</span>;
  const good = lowerIsBetter ? r < 0 : r > 0;
  return (
    <span className="d">
      직전 기간 대비{" "}
      <b className={good ? "sts-up" : "sts-down"}>
        {r > 0 ? "▲" : "▼"} {Math.abs(r * 100).toFixed(1)}%
      </b>
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div data-testid="stats-kpi">
      <span className="l">{label}</span>
      <span className="v">{value}</span>
      {children}
    </div>
  );
}

const Soon = () => <span className="bdg b-gray nodot">{SOON}</span>;

export default function StatsOverviewPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("overview", period);
  const data = state.kind === "ok" ? state.data : null;

  // 화면의 표를 한 파일로 내려받는다
  const download = () => {
    if (!data) return;
    const c = data.broadcasts;
    const live = c.rows.reduce((a, r) => ({ orders: a.orders + r.orders, net: a.net + r.net }), { orders: 0, net: 0 });
    const rows: (string | number | null)[][] = [["일별 매출 · 주문"], ["기간", "매출", "주문 수"]];
    for (const p of data.series) rows.push([p.bucket, p.revenue, p.orders]);
    rows.push([], ["방송 내역"], ["구분", "주문 수", "매출"], ["방송 매출", live.orders, live.net], ["방송 시간 일반 주문", c.general.orders, c.general.net], ["방송 외 주문", c.outside.orders, c.outside.net]);
    rows.push([], ["상품 상위"], ["상품", "판매 수량", "매출", "주문 수"]);
    for (const p of data.products.top.slice(0, PRODUCT_ROWS)) rows.push([p.deleted ? `${p.name} (삭제됨)` : p.name, p.quantity, p.revenue, p.orders]);
    downloadCsv(`stats-summary_${data.range.from}_${data.range.to}.csv`, ["통계 요약", `${data.range.from} ~ ${data.range.to}`], rows);
  };

  // 표시할 항목이 모두 비었을 때만 빈 화면(주문이 없어도 방송·적립금·비교값이 있으면 요약을 그린다)
  const empty = data && !overviewHasData(data);

  return (
    <StatsFrame title="요약" heading="통계 · 요약" sub="매출 · 주문 · 방송 · 상품 · 회원 지표를 한 번에 봅니다" period={period} setPeriod={setPeriod} onDownload={data && !empty ? download : undefined} comparable>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && empty && <EmptyStats text="아직 집계할 주문이 없습니다" sub="첫 주문이 들어오면 통계가 표시됩니다" />}
      {data && !empty && <Overview data={data} compare={period.compare} />}
    </StatsFrame>
  );
}

function Overview({ data, compare }: { data: Data; compare: boolean }) {
  const c = data.summary.current;
  const p = data.summary.previous;
  const points = data.series.map((s) => ({ label: bucketLabel(s.bucket, data.range.unit), value: Math.max(0, s.revenue) }));
  const best = data.series.reduce<(typeof data.series)[number] | null>((b, s) => (b === null || s.revenue > b.revenue ? s : b), null);
  const live = data.broadcasts.rows.reduce((a, r) => ({ orders: a.orders + r.orders, net: a.net + r.net }), { orders: 0, net: 0 });
  const bcast = [
    { label: "방송 매출", ...live },
    { label: "방송 시간 일반 주문", ...data.broadcasts.general },
    { label: "방송 외 주문", ...data.broadcasts.outside },
  ];
  const bTotal = bcast.reduce((a, r) => ({ orders: a.orders + r.orders, net: a.net + r.net }), { orders: 0, net: 0 });
  const share = (n: number) => (bTotal.net > 0 ? ` (${Math.round((n / bTotal.net) * 100)}%)` : "");
  const top = data.products.top.slice(0, PRODUCT_ROWS);

  return (
    <>
      <p className="sts-note">
        매출 · 주문 · 회원 통계를 볼 수 있는 권한(매출 보기)이 있는 계정에만 보입니다. 날짜는 한국 시간 기준입니다. 직전 기간은 {md(data.range.previous.from)} ~ {md(data.range.previous.to)}입니다.
      </p>
      <div className="sts-sum">
        <Tile label="매출 (결제 기준)" value={won(c.revenue)}>
          {cmpLine(compare, c.revenue, p.revenue, won)}
        </Tile>
        <Tile label="주문" value={count(c.orders)}>
          {cmpLine(compare, c.orders, p.orders, count)}
        </Tile>
        <Tile label="주문당 평균" value={c.averageOrderValue === null ? "—" : won(c.averageOrderValue)}>
          {cmpLine(compare, c.averageOrderValue, p.averageOrderValue, won)}
        </Tile>
        <Tile label="취소 · 환불" value={`${count(c.excluded)}${data.operations.refundAmount > 0 ? ` · ${won(data.operations.refundAmount)}` : ""}`}>
          {cmpLine(compare, c.excluded, p.excluded, count, true)}
        </Tile>
        <Tile label="신규 회원" value={people(c.signups)}>
          {cmpLine(compare, c.signups, p.signups, people)}
        </Tile>
        <Tile label="방문자" value={<Soon />}>
          <span className="d">방문 집계 연동 뒤 제공</span>
        </Tile>
      </div>

      <section className="sts-sec">
        <div className="sts-sec-h">
          <h2>일별 매출</h2>
          {best && best.revenue > 0 && (
            <span className="t-c1 c-alt">
              최고 {bucketLabel(best.bucket, data.range.unit)} {won(best.revenue)}
            </span>
          )}
        </div>
        <BarChart bare title="일별 매출" fmt={won} points={points} />
      </section>

      <section className="sts-sec">
        <div className="sts-sec-h">
          <h2>방송 내역</h2>
          <Link className="btn btn-out" href="/seller/stats/broadcasts">
            방송 통계
          </Link>
        </div>
        <table className="sts-tbl" data-testid="overview-broadcasts">
          <thead>
            <tr>
              <th>구분</th>
              <th>주문</th>
              <th>매출</th>
            </tr>
          </thead>
          <tbody>
            {bcast.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{count(r.orders)}</td>
                <td>
                  {won(r.net)}
                  {share(r.net)}
                </td>
              </tr>
            ))}
            <tr className="total">
              <td>합계</td>
              <td>{count(bTotal.orders)}</td>
              <td>{won(bTotal.net)}</td>
            </tr>
          </tbody>
        </table>
        <span className="t-c1 c-alt">방송 시작 ~ 종료(방송 매출), 종료 뒤 2시간(방송 시간 일반 주문), 그 밖(방송 외 주문)으로 나눈 값이며 합계는 위 매출과 같습니다. 시청자 수는 준비 중입니다.</span>
      </section>

      <section className="sts-sec">
        <div className="sts-sec-h">
          <h2>상품 상위 {PRODUCT_ROWS}</h2>
          <Link className="btn btn-out" href="/seller/stats/products">
            상품 통계
          </Link>
        </div>
        {top.length === 0 ? (
          <span className="t-l2 c-alt">선택한 기간에 팔린 상품이 없습니다</span>
        ) : (
          <table className="sts-tbl" data-testid="overview-products">
            <thead>
              <tr>
                <th style={{ width: 64 }}>순위</th>
                <th>상품</th>
                <th>판매</th>
                <th>매출</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r, i) => (
                <tr key={r.productId}>
                  <td>{i + 1}</td>
                  <td>{r.deleted ? `${r.name} (삭제됨)` : r.name}</td>
                  <td>{r.quantity.toLocaleString("ko-KR")}개</td>
                  <td>{won(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="sts-sec">
        <div className="sts-sec-h">
          <h2>회원 · 적립금 · 쿠폰</h2>
          <Link className="btn btn-out" href="/seller/stats/members">
            회원 통계
          </Link>
        </div>
        <table className="au-ft" data-testid="overview-rewards">
          <tbody>
            <tr>
              <th scope="row">구매 회원</th>
              <td>
                {people(data.members.buyers)} · 재구매율 {pct(data.members.repeatRate)} ({people(data.members.repeatBuyers)})
              </td>
            </tr>
            <tr>
              <th scope="row">신규 · 기존 매출</th>
              <td>
                신규 {won(data.members.newNet)} · 기존 {won(data.members.returningNet)}
              </td>
            </tr>
            <tr>
              <th scope="row">적립금</th>
              <td>
                지급 {won(data.rewards.earned)} · 회수 {won(data.rewards.revoked)} · 사용 {won(data.rewards.used)} (매출의 {pct(data.rewards.useRate)}) · 소멸 {won(data.rewards.expired)}
              </td>
            </tr>
            <tr>
              <th scope="row">쿠폰 사용</th>
              <td>
                {count(data.coupons.used)} · 할인 {won(data.coupons.discount)}
              </td>
            </tr>
            <tr>
              <th scope="row">결제 → 발송</th>
              <td data-testid="overview-operations">
                평균 {hours(data.operations.shipping.avgHours)} · 발송 {count(data.operations.shipping.shipped)} · 미입금 자동 취소 {count(data.operations.autoCancelled)} ({pct(data.operations.autoCancelRate)})
              </td>
            </tr>
            <tr>
              <th scope="row">교환 · 반품 · 리뷰 · 문의</th>
              <td>
                <Soon />
              </td>
            </tr>
          </tbody>
        </table>
        <span className="t-c1 c-alt">신규 = 그 기간에 첫 결제한 회원 · 적립금은 처리가 끝난 시각 기준</span>
      </section>
    </>
  );
}
