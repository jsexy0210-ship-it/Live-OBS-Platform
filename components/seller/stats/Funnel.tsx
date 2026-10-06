"use client";

import { useState } from "react";
import { StatsState, daysBetween, shift, useStats, type Period } from "./StatsFrame";
import { pct } from "./parts";

// SA-056 통계 · 상품 > 상품 전환 퍼널(정본 SA-056-P). GET /api/seller/stats/funnel: 로그인한 구매자 회원만 센 상품 조회 → 장바구니 담기 → 주문 → 결제.
// 조회·담기는 같은 회원이 같은 상품을 같은 날 여러 번 해도 한 번으로 센 값이다. 상품별은 조회 많은 순 상위 20개로 오고, 정렬 3가지는 이 화면에서 바꿔 본다.
type Steps = { viewToCart: number | null; cartToOrder: number | null; orderToPaid: number | null };
type Totals = Steps & { views: number; cartAdds: number; orders: number; paidOrders: number };
type Row = Steps & { productId: string; name: string; views: number; cartAdds: number; orders: number; paidOrders: number };
type Data = { range: { from: string; to: string }; basis: "login_members"; totals: Totals; products: Row[] };

// 전환 기록을 쌓기 시작한 날(정본 상태 변형 「퍼널 집계 전」). 이 날 전 기간은 조회·담기가 0으로 보인다
export const FUNNEL_START = "2026-10-05";

const SORTS = [
  { key: "views", label: "조회 많은 순" },
  { key: "paid", label: "결제 많은 순" },
  { key: "lowCart", label: "조회 → 담기 낮은 순" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

const n = (v: number) => v.toLocaleString("ko-KR");

function sorted(rows: Row[], key: SortKey): Row[] {
  const list = [...rows];
  if (key === "paid") return list.sort((a, b) => b.paidOrders - a.paidOrders || b.views - a.views);
  // 조회가 0인 상품은 비율이 없어 맨 뒤로 보낸다
  if (key === "lowCart") return list.sort((a, b) => (a.viewToCart ?? 2) - (b.viewToCart ?? 2) || b.views - a.views);
  return list;
}

// 비교 기간 대비 퍼센트포인트 차이(조회 → 담기)
function Pp({ now, prev }: { now: number | null; prev: number | null }) {
  if (now === null || prev === null) return <span className="d">바로 앞 기간 —</span>;
  const d = (now - prev) * 100;
  const same = Math.abs(d) < 0.05;
  return (
    <span className="d">
      바로 앞 기간 {pct(prev)} ·{" "}
      {same ? (
        "같음"
      ) : (
        <b className={d > 0 ? "sts-up" : "sts-down"}>
          {d > 0 ? "+" : "−"}
          {Math.abs(d).toFixed(1)}%p
        </b>
      )}
    </span>
  );
}

export default function Funnel({ period }: { period: Period }) {
  const { state, reload } = useStats<Data>("funnel", period);
  // 바로 앞 기간: 같은 일수만큼 앞(비교를 끄면 부르지 않는다)
  const days = daysBetween(period.from, period.to);
  const prevTo = shift(period.from, -1);
  const prev = useStats<Data>("funnel", { ...period, from: shift(prevTo, -(days - 1)), to: prevTo }, !period.compare);
  const [sort, setSort] = useState<SortKey>("views");
  const data = state.kind === "ok" ? state.data : null;
  const base = data ? Math.max(1, data.totals.views, data.totals.cartAdds, data.totals.orders, data.totals.paidOrders) : 1;
  const prevRatio = period.compare && prev.state.kind === "ok" ? prev.state.data.totals.viewToCart : null;

  return (
    <section className="sts-funnel" aria-labelledby="sts-funnel-t" data-testid="stats-funnel">
      <div className="sts-h" style={{ padding: "0 0 12px", justifyContent: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <h2 className="t-t3" id="sts-funnel-t" style={{ margin: 0, fontSize: 18 }}>
          상품 전환 퍼널
        </h2>
        <span className="t-c1 c-alt">로그인 회원 기준 · 상품 조회 → 장바구니 담기 → 주문 → 결제 · 같은 기간</span>
      </div>
      <StatsState state={state} onRetry={() => void reload()} />
      {data && (
        <>
          {period.from < FUNNEL_START && (
            <div className="msg msg-info" role="note" data-testid="funnel-before">
              <span>상품 전환 집계는 10/5부터 쌓입니다. 그 전 기간은 조회 · 담기가 0으로 보이고 주문 · 결제만 표시됩니다.</span>
            </div>
          )}
          <div className="sts-fsteps" data-testid="funnel-steps">
            <div className="stat">
              <span className="t-l2 c-alt">상품 조회</span>
              <span className="v">{n(data.totals.views)}명</span>
              <span className="d">기준 100%</span>
            </div>
            <div className="sts-fcv" data-testid="funnel-rate-cart">
              <span className="t-c1 c-alt">조회 → 담기</span>
              <b>{pct(data.totals.viewToCart)}</b>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">장바구니 담기</span>
              <span className="v">{n(data.totals.cartAdds)}명</span>
              {period.compare ? <Pp now={data.totals.viewToCart} prev={prevRatio} /> : <span className="d">&nbsp;</span>}
            </div>
            <div className="sts-fcv" data-testid="funnel-rate-order">
              <span className="t-c1 c-alt">담기 → 주문</span>
              <b>{pct(data.totals.cartToOrder)}</b>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">주문</span>
              <span className="v">{n(data.totals.orders)}건</span>
              <span className="d">상태와 관계없이</span>
            </div>
            <div className="sts-fcv" data-testid="funnel-rate-paid">
              <span className="t-c1 c-alt">주문 → 결제</span>
              <b>{pct(data.totals.orderToPaid)}</b>
            </div>
            <div className="stat">
              <span className="t-l2 c-alt">결제</span>
              <span className="v">{n(data.totals.paidOrders)}건</span>
              <span className="d">결제된 적 있는 주문</span>
            </div>
          </div>

          <div className="sts-fbars" role="img" aria-label={`상품 조회 ${n(data.totals.views)}, 장바구니 담기 ${n(data.totals.cartAdds)}, 주문 ${n(data.totals.orders)}, 결제 ${n(data.totals.paidOrders)}`}>
            {(
              [
                ["상품 조회", data.totals.views],
                ["장바구니 담기", data.totals.cartAdds],
                ["주문", data.totals.orders],
                ["결제", data.totals.paidOrders],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="sts-fbar">
                <span>{label}</span>
                <span className="sts-ftrack">
                  <i style={{ width: `${v > 0 ? Math.max(1, (v / base) * 100) : 0}%` }} />
                </span>
                <span className="num">{n(v)}</span>
              </div>
            ))}
          </div>

          <div className="sts-h" style={{ padding: "8px 0 8px", gap: 12 }}>
            <span>
              <b>상품별 상위 20개</b> <span className="t-c1 c-alt">({SORTS.find((s) => s.key === sort)!.label})</span>
            </span>
            <select className="inp" style={{ width: 200 }} aria-label="상품별 정렬" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {data.products.length === 0 ? (
            <div className="card">
              <div className="st" style={{ boxShadow: "none", minHeight: 120 }}>
                <span className="t">선택한 기간에 집계된 상품이 없습니다</span>
                <span className="s">기간을 바꿔 조회할 수 있습니다</span>
              </div>
            </div>
          ) : (
            <div className="card sts-scroll">
              <table className="tbl" data-testid="funnel-table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>순위</th>
                    <th>상품</th>
                    <th>기간 보기</th>
                    <th>담기</th>
                    <th>주문</th>
                    <th>결제</th>
                    <th>조회 → 담기</th>
                    <th>담기 → 주문</th>
                    <th>주문 → 결제</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted(data.products, sort).map((r, i) => (
                    <tr key={r.productId}>
                      <td className="num">{i + 1}</td>
                      <td className="col-text sts-name">{r.name}</td>
                      <td className="num">{n(r.views)}</td>
                      <td className="num">{n(r.cartAdds)}</td>
                      <td className="num">{n(r.orders)}</td>
                      <td className="num">{n(r.paidOrders)}</td>
                      <td className="num">{pct(r.viewToCart)}</td>
                      <td className="num">{pct(r.cartToOrder)}</td>
                      <td className="num">{pct(r.orderToPaid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="t-c1 c-alt sts-sub-note" style={{ marginTop: 8 }}>
            로그인 회원만 집계합니다 · 같은 회원이 하루에 여러 번 본 조회 · 담기는 한 번으로 셉니다 · 주문은 상태와 관계없이 그 상품이 든 주문 수, 결제는 그 가운데 결제된 적 있는 주문 · 조회 수가 적은 상품의 전환율은 참고만 해 주십시오
          </p>
        </>
      )}
    </section>
  );
}
