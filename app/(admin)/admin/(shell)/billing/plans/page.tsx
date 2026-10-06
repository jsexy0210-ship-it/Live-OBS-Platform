"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { MAIL_QUOTA_MAX_UI, type AdminPlan } from "../../../_components/messageFees";
import { dayTime, won } from "../../../_components/partners";
import { PlanPriceDialog } from "../../../_components/PlanPriceDialog";
import { PlanTrialDialog } from "../../../_components/PlanTrialDialog";
import { ValueDialog } from "../../../_components/ValueDialog";

// MA-021 요금제 목록·MA-022 가격·체험 한도·월 거래 메일 제공량. 데이터는 GET /api/admin/plans(모든 마스터 역할).
// 바꾸기: 가격·제공량은 최고관리자만(billing.price), 체험 한도는 최고관리자·운영 담당(billing.manage).
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; plans: AdminPlan[] };
type Dialog = { kind: "price" | "trial" | "quota"; plan: AdminPlan };

export default function PlansPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "billing.price");
  const canTrial = adminCan(me.role, "billing.manage");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<{ plans: AdminPlan[] }>("/api/admin/plans");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", plans: r.data.plans } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

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
                {state.plans.map((p) => (
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
                    {(canEdit || canTrial) && (
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        {canEdit && (
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setDialog({ kind: "price", plan: p })}>
                            가격 변경
                          </button>
                        )}
                        {canTrial && (
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setDialog({ kind: "trial", plan: p })}>
                            체험 한도 변경
                          </button>
                        )}
                        {canEdit && (
                          <button className="btn btn-sm btn-out" type="button" onClick={() => setDialog({ kind: "quota", plan: p })}>
                            월 무료 메일 수량 변경
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ))}
        </div>
        <p className="t-c1 c-alt">무료 수량은 한 달 단위(한국 시간)이며 남아도 다음 달로 넘어가지 않습니다. 무료 수량을 넘는 메일은 파트너스의 충전 잔액에서 빠집니다.</p>
      </main>
      {dialog?.kind === "price" && (
        <PlanPriceDialog
          plan={dialog.plan}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setToast("가격을 저장했습니다.");
            void load();
          }}
        />
      )}
      {dialog?.kind === "trial" && (
        <PlanTrialDialog
          plan={dialog.plan}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setToast("체험 한도를 저장했습니다.");
            void load();
          }}
        />
      )}
      {dialog?.kind === "quota" && (
        <ValueDialog
          title={`${dialog.plan.name} 월 무료 메일 수량 변경`}
          label="월 주문·배송 안내 메일 무료 수량"
          unit="통"
          current={dialog.plan.mailMonthlyQuota}
          max={MAIL_QUOTA_MAX_UI}
          path={`/api/admin/plans/${dialog.plan.code}/mail-quota`}
          field="monthlyQuota"
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setToast("제공량을 저장했습니다.");
            void load();
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
