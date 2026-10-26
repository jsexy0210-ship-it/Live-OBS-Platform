"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, Pagination } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { type AdminPlan } from "../../../_components/messageFees";
import { dayTime, won } from "../../../_components/partners";

// MA-021 요금제 목록·MA-022 가격·체험 한도·월 거래 메일 제공량. 데이터는 GET /api/admin/plans(모든 마스터 역할).
// 바꾸기: 가격·제공량은 최고관리자만(billing.price), 체험 한도는 최고관리자·운영 담당(billing.manage).
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; plans: AdminPlan[] };

export default function PlansPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  useEffect(() => { const n = Number(new URLSearchParams(window.location.search).get("page")); if (Number.isInteger(n) && n > 0) setPage(n); }, []);

  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<{ plans: AdminPlan[] }>("/api/admin/plans");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", plans: r.data.plans } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);
  const plans = state.kind === "ok" ? state.plans : [];
  const pageCount = Math.ceil(plans.length / 10);
  const currentPage = Math.min(page, pageCount || 1);
  useEffect(() => { if (state.kind === "ok") setPage(p => Math.min(p, Math.max(1, Math.ceil(state.plans.length / 10)))); }, [state]);

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 요금제" />
      <main className="main">
        <PageHead title="요금제" description="요금제별 가격과 제공량을 확인하고, 현재 설정을 관리합니다." />
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={3} />}
          {state.kind === "error" && <ErrorState title="요금제를 불러오지 못했습니다." onRetry={() => void load()} />}
          {state.kind === "ok" &&
            (state.plans.length === 0 ? (
              <div className="st">
                <span className="t">등록된 요금제가 없습니다.</span>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 12 }}>
                {plans.slice((currentPage - 1) * 10, currentPage * 10).map((p) => (
                  <article key={p.code} className="card pad col" data-testid="plan-row" style={{ gap: 12, minWidth: 0 }}>
                    <div>
                      <h2 className="t-l1 fw6" style={{ margin: 0 }}>{p.name}</h2>
                      <div className="t-c1 c-alt" style={{ marginTop: 6 }}>
                        <s>정가 월 {won(p.listPrice)}</s>
                      </div>
                      <div className="t-h2 fw6" data-testid="plan-sale-price">
                        {won(p.salePrice)}<span className="t-c1 c-alt fw4"> / 월 · 부가세 포함</span>
                      </div>
                    </div>
                    <dl className="col" style={{ gap: 0, margin: 0 }}>
                      <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e4e7eb)" }}>
                        <dt className="t-c1 c-alt">월 무료 메일</dt>
                        <dd style={{ flex: 1, minWidth: 0, margin: 0, overflowWrap: "anywhere", textAlign: "right" }}>
                          주문 · 배송 안내 메일 {p.mailMonthlyQuota.toLocaleString("ko-KR")}통
                          {p.next && <div className="t-c1 c-alt" data-testid="plan-next-quota">{dayTime(p.next.effectiveAt)}부터 {p.next.mailMonthlyQuota.toLocaleString("ko-KR")}통 (적용 예정)</div>}
                        </dd>
                      </div>
                      <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e4e7eb)" }}>
                        <dt className="t-c1 c-alt">체험 한도</dt>
                        <dd data-testid="plan-trial-limits" style={{ flex: 1, minWidth: 0, margin: 0, overflowWrap: "anywhere", textAlign: "right" }}>
                          {p.trialDays === 0 ? "— (체험 없음)" : `알림톡 · 문자 ${p.trialMessageLimit.toLocaleString("ko-KR")}건 · 휴대폰 본인확인 ${p.trialIdentityLimit.toLocaleString("ko-KR")}건 · 저장 용량 ${p.trialStorageMb.toLocaleString("ko-KR")}MB`}
                        </dd>
                      </div>
                      <div className="row" style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line, #e4e7eb)" }}>
                        <dt className="t-c1 c-alt">무료 체험 중</dt>
                        <dd data-testid="plan-trial-days" style={{ flex: 1, minWidth: 0, margin: 0, overflowWrap: "anywhere", textAlign: "right" }}>
                          {p.trialDays === 0 ? "없음 · 구독 시작하면 바로 결제" : `${p.trialDays}일`}
                        </dd>
                      </div>
                    </dl>
                    <Link className="btn btn-sm btn-out" href={`/admin/billing/plans/${p.code}?returnTo=${encodeURIComponent(`/admin/billing/plans?page=${currentPage}`)}`}>상세</Link>
                  </article>
                ))}
              </div>
            ))}
        </div>
        {state.kind === "ok" && <span className="t-c1 c-alt">전체 요금제 {plans.length}개</span>}
        {pageCount > 1 && <Pagination page={currentPage} pageCount={pageCount} onChange={setPage} />}
        <p className="t-c1 c-alt">무료 수량은 한 달 단위(한국 시간)이며 남아도 다음 달로 넘어가지 않습니다. 무료 수량을 넘는 메일은 파트너스의 충전 잔액에서 빠집니다.</p>
      </main>
    </>
  );
}
