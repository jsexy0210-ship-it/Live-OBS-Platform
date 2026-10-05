"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { MAIL_QUOTA_MAX_UI, type MessageSettings, type PlanQuota } from "../../../_components/messageFees";
import { dayTime } from "../../../_components/partners";
import { ValueDialog } from "../../../_components/ValueDialog";

// MA-021 요금제 목록 중 월 거래 메일 제공량(MA-022). 데이터는 GET /api/admin/message-settings의 plans(모든 마스터 역할), 바꾸기는 최고관리자만.
// 가격·체험 한도·체험 일수는 마스터 쪽 요금제 목록 API(가격 포함)가 없어 아직 이 화면에 없다.
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; plans: PlanQuota[] };

export default function PlansPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "billing.price");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [dialog, setDialog] = useState<PlanQuota | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<MessageSettings>("/api/admin/message-settings");
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
                      <th>월 거래 메일 제공량</th>
                      <th>변경 후 제공량</th>
                      <th>적용 예정일</th>
                      {canEdit && <th>작업</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {state.plans.map((p) => (
                      <tr key={p.code} data-testid="plan-row">
                        <td className="fw6">{p.name}</td>
                        <td className="num">{p.mailMonthlyQuota.toLocaleString("ko-KR")}통</td>
                        <td className="num">{p.next ? `${p.next.mailMonthlyQuota.toLocaleString("ko-KR")}통` : "-"}</td>
                        <td className="num">{p.next ? dayTime(p.next.effectiveAt) : "-"}</td>
                        {canEdit && (
                          <td>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setDialog(p)}>
                              제공량 변경
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
        <p className="t-c1 c-alt">월 제공량은 한국 시간 기준 한 달 단위이고 남아도 다음 달로 넘어가지 않습니다. 제공량을 넘는 메일은 파트너스의 발송 잔액에서 차감됩니다.</p>
      </main>
      {dialog && (
        <ValueDialog
          title={`${dialog.name} 월 제공량 변경`}
          label="월 거래 메일 제공량"
          unit="통"
          current={dialog.mailMonthlyQuota}
          max={MAIL_QUOTA_MAX_UI}
          path={`/api/admin/plans/${dialog.code}/mail-quota`}
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
