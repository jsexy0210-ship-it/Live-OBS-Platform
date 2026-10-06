"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import type { PayoutSeller } from "../../../_components/ops";
import { day, won } from "../../../_components/partners";

// MA-043 적립금 실지급 파트너스(GET /api/admin/ops/live-payout-sellers, 모든 마스터 역할, 조회만). 실지급을 켠 시각이 최근인 순.
// 남은 적립금은 회원에게 아직 쓰이지 않고 남은 합계다. 회원 개인 단위는 보이지 않는다.
const TIMING = { ON_PAYMENT: "결제 시", ON_DELIVERY: "배송 완료 후" } as const;
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; at: string; items: PayoutSeller[] };

export default function LivePayoutPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<{ at: string; items: PayoutSeller[] }>("/api/admin/ops/live-payout-sellers");
    setState(r.ok ? { kind: "ok", at: r.data.at, items: r.data.items } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const items = state.kind === "ok" ? state.items : [];
  return (
    <>
      <AdminTopbar crumb="파트너스 › 적립금 실제 지급 켠 파트너스" />
      <main className="main">
        <PageHead title="적립금 실제 지급 켠 파트너스" description="실제 지급을 켠 파트너스의 발행 잔액, 월 거래액과 지급 징후를 확인합니다." />
        <div className="col" style={{ gap: 20 }}>
          {state.kind === "ok" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              {[
                ["켜진 파트너스", `${items.length}곳`, "pay-count"],
                ["남은 적립금 합계", won(items.reduce((s, x) => s + x.outstanding.amount, 0)), "pay-amount"],
                ["적립금 보유 회원", `${items.reduce((s, x) => s + x.outstanding.members, 0).toLocaleString("ko-KR")}명`, "pay-members"],
                ["이번 달 결제 순액", won(items.reduce((s, x) => s + x.monthTradingAmount, 0)), "pay-month-net"],
                ["잔액 비율 25% 초과", `${items.filter((x) => x.signals.balanceRatio.state === "WARN").length}곳`, "pay-ratio-warn"],
              ].map(([label, value, id]) => (
                <div key={id} className="card pad col" style={{ gap: 4 }}>
                  <span className="t-l2 c-alt">{label}</span>
                  <span className="t-h2" data-testid={id}>
                    {value}
                  </span>
                </div>
              ))}
          {state.kind === "ok" && <p className="t-c1 c-alt" style={{ margin: 0 }}>기준 시각 {day(state.at)}. 이번 달 거래액은 이번 달 결제일 기준 순액이며 현재 환불을 반영합니다. 잔액 비율 경고 기준은 25% 초과입니다. 수동 지급액은 성공한 비테스트 양수 조정의 최근 30×24시간 합계입니다. 지급 실패는 모의·날짜 누락 자료가 있으면 합계를 확정할 수 없습니다. 수동 지급 집중도 기준은 정해져 있지 않습니다.</p>}
            </div>
          )}
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" && <ErrorState title="실지급 파트너스를 불러오지 못했습니다." onRetry={() => void load()} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">실지급을 켠 파트너스가 없습니다.</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} unit="곳" />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>파트너스</th>
                          <th>켠 날짜</th>
                          <th>적립금을 주는 때</th>
                          <th>남은 적립금</th>
                          <th>적립금 보유 회원</th>
                          <th>이번 달 결제 순액</th>
                          <th>잔액 비율</th>
                          <th>최대 설정 지급률</th>
                          <th>오늘 지급 성공 / 실패</th>
                          <th>최근 30일 수동 지급</th>
                          <th>징후</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((s) => (
                          <tr key={s.sellerId} data-testid="payout-row">
                            <td>
                              <b>{s.shopName}</b> <span className="c-alt">· 쇼핑몰 주소 {s.slug}</span>
                            </td>
                            <td>{day(s.enabledAt)}</td>
                            <td>{TIMING[s.earnTiming]}</td>
                            <td>{won(s.outstanding.amount)}</td>
                            <td>{s.outstanding.members.toLocaleString("ko-KR")}명</td>
                            <td>{won(s.monthTradingAmount)}</td>
                            <td>{s.balanceRatioPercent == null ? "계산 불가" : `${s.balanceRatioPercent.toFixed(1)}%`}</td>
                            <td>{s.maxConfiguredRewardRatePercent == null ? "확인 불가" : `${s.maxConfiguredRewardRatePercent.toFixed(1)}%`}</td>
                            <td>{s.payoutToday.succeeded}건 성공 / {s.payoutToday.failed == null ? `확인 불가 (관측 실패 ${s.payoutToday.observedFailed}, 모의 ${s.payoutToday.uncertainModeFailed}, 날짜 누락 ${s.payoutToday.undatedFailed})` : `${s.payoutToday.failed}건 실패`}</td>
                            <td>{won(s.manualGrant30DaysAmount)}</td>
                            <td>잔액 {s.signals.balanceRatio.state === "WARN" ? "25% 초과" : s.signals.balanceRatio.state === "OK" ? "기준 이내" : "계산 불가"} · 지급 {s.signals.payoutFailure.state === "WARN" ? "실패 기록" : s.signals.payoutFailure.state === "OK" ? "확인된 실패 없음" : "확인 불가"} · 수동 집중도 기준 미정</td>
                            <td>
                              <Link className="btn btn-sm btn-out" href={`/admin/partners/${s.sellerId}`}>
                                상세
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ))}
          </div>
        </div>
      </main>
    </>
  );
}
