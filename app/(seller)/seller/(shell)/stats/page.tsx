"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyStats, StatsFrame, StatsState, usePeriod, useStats, type Unit } from "../../../../../components/seller/stats/StatsFrame";
import { overviewHasData } from "../../../../../components/seller/stats/overview";
import { BarChart, bucketLabel, count, downloadCsv, pct, won } from "../../../../../components/seller/stats/parts";

// SA-056 통계(요약). GET /api/seller/stats/overview 한 번으로 요약 지표·일별 매출·방송별 매출·상품별 판매·회원·적립금·주문 처리를 그린다.
// 데이터가 없는 지표(방문자·쿠폰·교환·반품·문의 답변·리뷰·회원 등급별)는 가짜 값 없이 「준비 중」으로 둔다.
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
const BROADCAST_ROWS = 5;
const PRODUCT_ROWS = 4;
const people = (n: number) => `${n.toLocaleString("ko-KR")}명`;
const md = (d: string) => d.slice(5).replace("-", "/").replace(/^0/, "").replace("/0", "/");
const kstDay = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const hours = (h: number | null) => (h === null ? "—" : h >= 24 ? `${Math.round((h / 24) * 10) / 10}일` : `${h}시간`);

function change(now: number | null, prev: number | null) {
  if (now === null || prev === null || prev === 0) return null;
  return (now - prev) / Math.abs(prev);
}

function Tile({ label, value, note, cmp }: { label: string; value: string; note: string; cmp?: string }) {
  return (
    <div className="stat" data-testid="stats-kpi">
      <span className="t-l2 c-alt">{label}</span>
      <span className="v">{value}</span>
      <span className="d">{note}</span>
      {cmp && <span className="d">{cmp}</span>}
    </div>
  );
}

export default function StatsOverviewPage() {
  const [period, setPeriod] = usePeriod();
  const { state, reload } = useStats<Data>("overview", period);
  const [metric, setMetric] = useState<"revenue" | "orders">("revenue");
  const [productSort, setProductSort] = useState<"revenue" | "quantity">("revenue");
  const [compare, setCompare] = useState(false);
  const [pick, setPick] = useState<{ open: boolean; daily: boolean; products: boolean; broadcasts: boolean }>({ open: false, daily: true, products: true, broadcasts: false });
  const data = state.kind === "ok" ? state.data : null;

  const download = () => {
    if (!data) return;
    const rows: (string | number | null)[][] = [];
    if (pick.daily) {
      rows.push(["일별 매출 · 주문"], ["기간", "매출", "주문 수"]);
      for (const p of data.series) rows.push([p.bucket, p.revenue, p.orders]);
      rows.push([]);
    }
    if (pick.products) {
      rows.push(["상품별 판매"], ["상품", "판매 수량", "매출", "주문 수"]);
      for (const p of data.products.top) rows.push([p.deleted ? `${p.name} (삭제됨)` : p.name, p.quantity, p.revenue, p.orders]);
      rows.push([]);
    }
    if (pick.broadcasts) {
      rows.push(["방송별 매출"], ["방송", "시작(KST)", "주문 수", "매출", "HIT"]);
      for (const b of data.broadcasts.rows) rows.push([b.title ?? `${kstDay(b.startedAt)} 방송`, kstDay(b.startedAt), b.orders, b.net, b.hits]);
      rows.push(["방송 시간 일반 주문", null, data.broadcasts.general.orders, data.broadcasts.general.net, null]);
      rows.push(["방송 외 주문", null, data.broadcasts.outside.orders, data.broadcasts.outside.net, null]);
    }
    if (rows.length === 0) return;
    downloadCsv(`stats-summary_${data.range.from}_${data.range.to}.csv`, ["통계 요약", `${data.range.from} ~ ${data.range.to}`], rows);
    setPick({ ...pick, open: false });
  };

  const downloadPanel = data && (
    <div className="sts-dl">
      <button className="btn btn-sm btn-out" type="button" aria-expanded={pick.open} onClick={() => setPick({ ...pick, open: !pick.open })}>
        엑셀(CSV) 내려받기
      </button>
      {pick.open && (
        <div className="menu sts-dl-menu" role="group" aria-label="내려받을 표">
          <span className="menu-h">내려받을 표</span>
          <label className="chk t-l2">
            <input className="cbx" type="checkbox" checked={pick.daily} onChange={(e) => setPick({ ...pick, daily: e.target.checked })} />
            일별 매출 · 주문
          </label>
          <label className="chk t-l2">
            <input className="cbx" type="checkbox" checked={pick.products} onChange={(e) => setPick({ ...pick, products: e.target.checked })} />
            상품별 판매
          </label>
          <label className="chk t-l2">
            <input className="cbx" type="checkbox" checked={pick.broadcasts} onChange={(e) => setPick({ ...pick, broadcasts: e.target.checked })} />
            방송별 매출
          </label>
          <span className="t-c1 c-alt">개인정보(이름 · 연락처)는 포함하지 않습니다</span>
          <button className="btn btn-sm" type="button" disabled={!pick.daily && !pick.products && !pick.broadcasts} onClick={download}>
            내려받기
          </button>
        </div>
      )}
    </div>
  );

  // 표시할 항목이 모두 비었을 때만 빈 화면(주문이 없어도 방송·적립금·비교값이 있으면 요약을 그린다)
  const empty = data && !overviewHasData(data);

  return (
    <StatsFrame title="요약" heading="통계" sub="매출 · 주문 · 방송 · 상품 · 회원 · 적립금 지표 · 기간 비교 · 내려받기" period={period} setPeriod={setPeriod} download={downloadPanel}>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && empty && <EmptyStats text="아직 집계할 주문이 없습니다" sub="첫 주문이 들어오면 통계가 표시됩니다" />}
      {data && !empty && <Overview data={data} metric={metric} setMetric={setMetric} productSort={productSort} setProductSort={setProductSort} compare={compare} setCompare={setCompare} />}
    </StatsFrame>
  );
}

function Overview({ data, metric, setMetric, productSort, setProductSort, compare, setCompare }: {
  data: Data;
  metric: "revenue" | "orders";
  setMetric: (m: "revenue" | "orders") => void;
  productSort: "revenue" | "quantity";
  setProductSort: (s: "revenue" | "quantity") => void;
  compare: boolean;
  setCompare: (v: boolean) => void;
}) {
  const c = data.summary.current;
  const p = data.summary.previous;
  const prevLabel = `${md(data.range.previous.from)} ~ ${md(data.range.previous.to)}`;
  const delta = (now: number | null, prev: number | null) => {
    const r = change(now, prev);
    return r === null ? "직전 기간과 비교할 값 없음" : `직전 기간 대비 ${r > 0 ? "+" : ""}${(r * 100).toFixed(1)}%`;
  };
  const cmp = (prev: number | null, fmt: (n: number) => string, now: number | null) =>
    compare ? `${prevLabel} ${prev === null ? "—" : fmt(prev)}${now !== null && prev !== null ? ` · 차이 ${now - prev >= 0 ? "+" : "−"}${fmt(Math.abs(now - prev))}` : ""}` : undefined;

  const points = data.series.map((s) => ({ label: bucketLabel(s.bucket, data.range.unit), value: metric === "revenue" ? Math.max(0, s.revenue) : s.orders }));
  const best = data.series.reduce<(typeof data.series)[number] | null>((b, s) => (b === null || s[metric] > b[metric] ? s : b), null);

  // 정렬은 서버가 한다(수량순은 팔린 상품 전체에서 고른 목록)
  const sorted = productSort === "revenue" ? data.products.top : data.products.topByQuantity;
  const shown = sorted.slice(0, PRODUCT_ROWS);
  const restCount = data.products.total.products - shown.length;
  const restValue = productSort === "revenue" ? data.products.total.revenue - shown.reduce((a, r) => a + r.revenue, 0) : data.products.total.quantity - shown.reduce((a, r) => a + r.quantity, 0);
  const pv = (r: Product) => (productSort === "revenue" ? r.revenue : r.quantity);
  const pmax = Math.max(1, ...shown.map(pv), restValue);
  const pfmt = (n: number) => (productSort === "revenue" ? won(n) : `${n.toLocaleString("ko-KR")}개`);

  const memberNet = data.members.newNet + data.members.returningNet;

  return (
    <>
      <div className="row sts-cmp">
        <label className="chk t-c1">
          <input className="cbx" type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          지난 기간과 비교
        </label>
      </div>
      <div className="sts-kpis">
        <Tile label="매출 (결제 기준)" value={won(c.revenue)} note={delta(c.revenue, p.revenue)} cmp={cmp(p.revenue, won, c.revenue)} />
        <Tile label="주문" value={count(c.orders)} note={`취소 · 환불 ${count(c.excluded)} 제외`} cmp={cmp(p.orders, count, c.orders)} />
        <Tile label="주문당 평균" value={c.averageOrderValue === null ? "—" : won(c.averageOrderValue)} note={p.averageOrderValue === null ? "직전 기간 —" : `직전 기간 ${won(p.averageOrderValue)}`} />
        <Tile label="방문자" value={SOON} note="방문 집계 연동 뒤 제공" />
        <Tile label="신규 회원" value={people(c.signups)} note={`구매 회원 ${people(c.buyers)}`} cmp={cmp(p.signups, people, c.signups)} />
      </div>

      <div className="sts-grid">
        <section className="card pad-l col" style={{ gap: 12 }}>
          <div className="row between">
            <h2 className="t-hl1">일별 매출 · 주문</h2>
            <div className="seg" role="group" aria-label="그래프 값">
              <button type="button" className={metric === "revenue" ? "on" : ""} aria-pressed={metric === "revenue"} onClick={() => setMetric("revenue")}>
                매출
              </button>
              <button type="button" className={metric === "orders" ? "on" : ""} aria-pressed={metric === "orders"} onClick={() => setMetric("orders")}>
                주문 수
              </button>
            </div>
          </div>
          <BarChart bare title={metric === "revenue" ? "일별 매출" : "일별 주문 수"} fmt={metric === "revenue" ? won : count} points={points} />
          {best && best[metric] > 0 && (
            <span className="t-c1 c-alt">
              최고: {bucketLabel(best.bucket, data.range.unit)} {metric === "revenue" ? won(best.revenue) : count(best.orders)}
            </span>
          )}
        </section>

        <section className="card pad-l col" style={{ gap: 12 }}>
          <div className="row between">
            <h2 className="t-hl1">방송별 매출</h2>
            <Link className="btn btn-sm btn-out" href="/seller/stats/broadcasts">
              방송 통계
            </Link>
          </div>
          <div className="sts-scroll">
            <table className="tbl" data-testid="overview-broadcasts">
              <thead>
                <tr>
                  <th>방송</th>
                  <th className="r">시청</th>
                  <th className="r">주문</th>
                  <th className="r">매출</th>
                  <th className="r">HIT</th>
                </tr>
              </thead>
              <tbody>
                {data.broadcasts.rows.slice(0, BROADCAST_ROWS).map((b) => (
                  <tr key={b.id}>
                    <td className="sts-name">
                      {kstDay(b.startedAt)} {b.title?.trim() || "방송"}
                    </td>
                    <td className="r sts-soon">{SOON}</td>
                    <td className="r num">{count(b.orders)}</td>
                    <td className="r num fw6">{won(b.net)}</td>
                    <td className="r num">{b.hits.toLocaleString("ko-KR")}</td>
                  </tr>
                ))}
                <tr className="sts-sub">
                  <td className="c-alt">방송 시간 일반 주문</td>
                  <td className="r c-alt">—</td>
                  <td className="r num">{count(data.broadcasts.general.orders)}</td>
                  <td className="r num fw6">{won(data.broadcasts.general.net)}</td>
                  <td className="r c-alt">—</td>
                </tr>
                <tr className="sts-sub">
                  <td className="c-alt">방송 외 주문</td>
                  <td className="r c-alt">—</td>
                  <td className="r num">{count(data.broadcasts.outside.orders)}</td>
                  <td className="r num fw6">{won(data.broadcasts.outside.net)}</td>
                  <td className="r c-alt">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <span className="t-c1 c-alt">기간 안 결제 주문을 방송 시작 ~ 종료(방송 매출), 종료 뒤 2시간(방송 시간 일반 주문), 그 밖(방송 외 주문)으로 나눈 값입니다 · 세 칸 합 = 매출 · 방송 통계 탭은 기간 중 시작한 방송 기준 · HIT는 방송 중 만든 카드 · 시청 수는 준비 중</span>
        </section>

        <section className="card pad-l col" style={{ gap: 12 }}>
          <div className="row between">
            <h2 className="t-hl1">상품별 판매</h2>
            <div className="seg" role="group" aria-label="상품 정렬">
              <button type="button" className={productSort === "revenue" ? "on" : ""} aria-pressed={productSort === "revenue"} onClick={() => setProductSort("revenue")}>
                매출순
              </button>
              <button type="button" className={productSort === "quantity" ? "on" : ""} aria-pressed={productSort === "quantity"} onClick={() => setProductSort("quantity")}>
                수량순
              </button>
            </div>
          </div>
          {shown.length === 0 ? (
            <span className="t-l2 c-alt">선택한 기간에 팔린 상품이 없습니다</span>
          ) : (
            <div className="col" style={{ gap: 10 }} data-testid="overview-products">
              {shown.map((r) => (
                <div key={r.productId} className="row sts-prow">
                  <span className="t-c1 ell sts-pname" title={r.name}>
                    {r.name}
                  </span>
                  <div className="bar" style={{ flex: 1 }}>
                    <i style={{ width: `${Math.max(2, (pv(r) / pmax) * 100)}%` }} />
                  </div>
                  <span className="t-c1 c-alt num sts-pval">{pfmt(pv(r))}</span>
                </div>
              ))}
              {restCount > 0 && (
                <div className="row sts-prow">
                  <span className="t-c1 sts-pname">그 외 {restCount}개 상품</span>
                  <div className="bar" style={{ flex: 1 }}>
                    <i style={{ width: `${Math.max(2, (restValue / pmax) * 100)}%`, background: "var(--wds-fill-strong)" }} />
                  </div>
                  <span className="t-c1 c-alt num sts-pval">{pfmt(restValue)}</span>
                </div>
              )}
            </div>
          )}
          <div className="row between t-c1 c-alt">
            <span>안 팔린 상품 {data.products.unsoldCount.toLocaleString("ko-KR")}종</span>
            <Link href="/seller/stats/products">상품 통계</Link>
          </div>
        </section>

        <section className="card pad-l col" style={{ gap: 12 }}>
          <h2 className="t-hl1">회원 · 재구매</h2>
          <div className="row" style={{ gap: 12 }}>
            <div className="col" style={{ flex: 1, gap: 4 }}>
              <span className="t-c1 c-alt">재구매율</span>
              <span className="t-hl1 num">{pct(data.members.repeatRate)}</span>
              <span className="t-c1 c-alt">구매 회원 {people(data.members.buyers)} 중 {people(data.members.repeatBuyers)}</span>
            </div>
            <div className="col" style={{ flex: 1, gap: 4 }}>
              <span className="t-c1 c-alt">신규 · 기존 매출</span>
              <span className="t-hl1 num">{memberNet > 0 ? `${Math.round((data.members.newNet / memberNet) * 100)}% · ${100 - Math.round((data.members.newNet / memberNet) * 100)}%` : "—"}</span>
              <span className="t-c1 c-alt">
                {won(data.members.newNet)} · {won(data.members.returningNet)}
              </span>
            </div>
            <div className="col" style={{ flex: 1, gap: 4 }}>
              <span className="t-c1 c-alt">회원 등급별 매출</span>
              <span className="t-hl1 sts-soon">{SOON}</span>
            </div>
          </div>
          <span className="t-c1 c-alt">신규 = 그 기간에 첫 결제한 회원 · 재구매 = 기간 끝까지 결제 2건 이상</span>
        </section>

        <section className="card pad-l col" style={{ gap: 12 }}>
          <h2 className="t-hl1">적립금 · 쿠폰</h2>
          <dl className="kv" data-testid="overview-rewards">
            <dt>적립금 지급</dt>
            <dd>
              {won(data.rewards.earned)} · 회수 {won(data.rewards.revoked)}
            </dd>
            <dt>적립금 사용</dt>
            <dd>
              {won(data.rewards.used)} · 매출의 {pct(data.rewards.useRate)}
            </dd>
            <dt>적립금 소멸</dt>
            <dd>{won(data.rewards.expired)}</dd>
            <dt>소멸 예정</dt>
            <dd className="sts-soon">{SOON}</dd>
            <dt>쿠폰 사용</dt>
            <dd className="sts-soon">{SOON}</dd>
          </dl>
          <span className="t-c1 c-alt">적립금은 처리가 끝난 시각 기준 · 사용 비율은 매출 대비</span>
          <div className="row" style={{ gap: 8 }}>
            <Link className="btn btn-sm btn-out" href="/seller/rewards">
              적립금
            </Link>
          </div>
        </section>

        <section className="card pad-l col" style={{ gap: 12 }}>
          <h2 className="t-hl1">주문 처리 · 서비스</h2>
          <dl className="kv" data-testid="overview-operations">
            <dt>결제 → 발송 평균</dt>
            <dd>
              {hours(data.operations.shipping.avgHours)} · 발송 {count(data.operations.shipping.shipped)}
            </dd>
            <dt>미입금 자동 취소</dt>
            <dd>
              {count(data.operations.autoCancelled)} · {pct(data.operations.autoCancelRate)}
            </dd>
            <dt>취소 · 환불</dt>
            <dd>
              취소 {count(data.operations.cancelled)} · 환불 {count(data.operations.refunded)} · {won(data.operations.refundAmount)}
            </dd>
            <dt>교환 · 반품</dt>
            <dd className="sts-soon">{SOON}</dd>
            <dt>문의 답변 평균</dt>
            <dd className="sts-soon">{SOON}</dd>
            <dt>리뷰 작성률</dt>
            <dd className="sts-soon">{SOON}</dd>
          </dl>
          <span className="t-c1 c-alt">기간 안 주문 기준 · 발송 평균은 결제부터 발송까지 · 자동 취소 비율은 주문 수 대비</span>
        </section>
      </div>
    </>
  );
}
