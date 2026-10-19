"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSmartBack } from "../../../../../../../lib/client/navigation";
import { useParams, useRouter } from "next/navigation";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { adminApi } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { MAIL_QUOTA_MAX_UI, type AdminPlan } from "../../../../_components/messageFees";
import { listReturnTo } from "../../../../_components/selection";
import { PlanPriceDialog } from "../../../../_components/PlanPriceDialog";
import { PlanTrialDialog } from "../../../../_components/PlanTrialDialog";
import { ValueDialog } from "../../../../_components/ValueDialog";

export default function PlanDetailPage() {
  const { planCode } = useParams<{ planCode: string }>();
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/admin/billing/plans");
  const leaveRef = useRef<((next?: () => void) => Promise<void>) | null>(null);
  const smartBack = useSmartBack(returnTo);
  useEffect(() => setReturnTo(listReturnTo(new URLSearchParams(window.location.search).get("returnTo"), "/admin/billing/plans")), []);
  const { me } = useAdmin();
  const [state, setState] = useState<AdminPlan | "loading" | "error" | "missing">("loading");
  const [action, setAction] = useState<"price" | "trial" | "quota" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await adminApi<{ plans: AdminPlan[] }>("/api/admin/plans");
    setState(r.ok ? r.data.plans.find(p => p.code === planCode) ?? "missing" : "error");
  }, [planCode]);
  useEffect(() => { void load(); }, [load]);
  const done = () => { router.push(returnTo); };
  const canPrice = adminCan(me.role, "billing.price");
  const canTrial = adminCan(me.role, "billing.manage");
  return <><AdminTopbar crumb="구독·요금 › 요금제 › 상세" /><main className="main">
    <PageHead onBack={() => leaveRef.current ? leaveRef.current(smartBack) : smartBack()} title="요금제 상세" actions={<Link className="btn btn-out" href={returnTo}>목록</Link>} />
    {typeof state === "string" ? state === "loading" ? <LoadingRows rows={3} /> : <ErrorState title={state === "missing" ? "요금제를 찾을 수 없습니다." : "요금제를 불러오지 못했습니다."} onRetry={() => void load()} /> : <>
      <section className="card pad-l col" style={{ gap: 16 }}><h2>{state.name}</h2><p>정가 {state.listPrice.toLocaleString("ko-KR")}원 · 판매가 {state.salePrice.toLocaleString("ko-KR")}원</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {canPrice && <button className="btn btn-out" disabled={action !== null} onClick={() => setAction("price")}>가격 변경</button>}
        {canTrial && <button className="btn btn-out" disabled={action !== null} onClick={() => setAction("trial")}>체험 한도 변경</button>}
        {canPrice && <button className="btn btn-out" disabled={action !== null} onClick={() => setAction("quota")}>월 무료 메일 수량 변경</button>}
      </div></section>
      {action === "price" && canPrice && <PlanPriceDialog key={`price-${state.listPrice}-${state.salePrice}`} plan={state} fullPage leaveRef={leaveRef} onClose={() => setAction(null)} onDone={done} />}
      {action === "trial" && canTrial && <PlanTrialDialog plan={state} fullPage leaveRef={leaveRef} onClose={() => setAction(null)} onDone={done} />}
      {action === "quota" && canPrice && <ValueDialog title={`${state.name} 월 무료 메일 수량 변경`} label="월 주문·배송 안내 메일 무료 수량" unit="통" current={state.mailMonthlyQuota} max={MAIL_QUOTA_MAX_UI} path={`/api/admin/plans/${state.code}/mail-quota`} field="monthlyQuota" fullPage leaveRef={leaveRef} onClose={() => setAction(null)} onDone={done} />}
    </>}
    {toast && <Toast text={toast} onDone={() => setToast(null)} />}
  </main></>;
}
