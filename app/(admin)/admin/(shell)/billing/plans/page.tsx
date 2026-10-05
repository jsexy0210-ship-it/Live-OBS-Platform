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
        <PageHead title="요금제" />
        <div className="card">
          {state.kind === "loading" && <LoadingRows rows={3} />}
          {state.kind === "error" && <ErrorState title="요금제를 불러오지 못했습니다." onRetry={() => void load()} />}
          {state.kind === "ok" &&
            (state.plans.length === 0 ? (
              <div className="st">
                <span className="t">등록된 요금제가 없습니다.</span>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>
                      <th>요금제</th>
                      <th>정가</th>
                      <th>판매가</th>
                      <th>체험 일수</th>
                      <th>체험 알림톡·문자</th>
                      <th>체험 중 휴대폰 본인확인</th>
                      <th>체험 저장 용량</th>
                      <th>월 주문·배송 안내 메일 무료 수량</th>
                      <th>바뀔 무료 수량</th>
                      <th>적용 예정일</th>
                      {(canEdit || canTrial) && <th>작업</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {state.plans.map((p) => (
                      <tr key={p.code} data-testid="plan-row">
                        <td className="fw6">{p.name}</td>
                        <td className="num">{won(p.listPrice)}</td>
                        <td className="num">{won(p.salePrice)}</td>
                        <td className="num">{p.trialDays}일</td>
                        <td className="num">{p.trialMessageLimit.toLocaleString("ko-KR")}건</td>
                        <td className="num">{p.trialIdentityLimit.toLocaleString("ko-KR")}건</td>
                        <td className="num">{p.trialStorageMb.toLocaleString("ko-KR")}MB</td>
                        <td className="num">{p.mailMonthlyQuota.toLocaleString("ko-KR")}통</td>
                        <td className="num">{p.next ? `${p.next.mailMonthlyQuota.toLocaleString("ko-KR")}통` : "-"}</td>
                        <td className="num">{p.next ? dayTime(p.next.effectiveAt) : "-"}</td>
                        {(canEdit || canTrial) && (
                          <td>
                            <div className="row" style={{ gap: 8 }}>
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
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
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
