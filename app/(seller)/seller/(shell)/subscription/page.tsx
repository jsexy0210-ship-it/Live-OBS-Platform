"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { won } from "../../../../../components/seller/format";
import { useLatestResponse } from "../../../../../components/seller/latestResponse";
import { PaymentHistory, type Payment } from "../../../../../components/seller/subscription/PaymentHistory";
import "../../../../../styles/seller-settings2.css";

// SA-090 구독 · 결제(대표자 전용). API: GET /api/seller/subscription, POST …/card · …/plan · …/cancel, GET /api/plans(바꿀 수 있는 플랜 이름).
// 카드 등록은 실제 결제 업체 창이 아직 없어 테스트 서버(GET /api/health의 testMode)에서만 가짜 카드로 연다(돈 이동 없음).

type Access = "trial" | "paid" | "charging" | "grace" | "expired";
type View = {
  access: Access;
  trialEndsAt: string | null;
  plan: { code: string; name: string; listPrice: number; salePrice: number; nextAmount: number } | null;
  subscription: {
    status: "ACTIVE" | "PAST_DUE" | "CANCELED";
    cardLabel: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    nextChargeAt: string | null;
    graceUntil: string | null;
    retryCount: number;
    pendingPlanCode: string | null;
  } | null;
  payments: Payment[];
};
type Plan = { code: string; name: string };
type PlanChange = { ok: true; applied: "now" | "next_payment" | "canceled_pending"; charged: number; planCode: string; effectiveAt: string | null; remainingDays?: number | null };

const DAY = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date(iso)) : "-";

// 플랜 순위(planChange.ts와 같은 기준): 올리면 남은 기간 차액을 바로 결제, 내리면 다음 결제일부터
const RANK: Record<string, number> = { OVERLAY_ONLY: 1, INTEGRATED: 2, STANDARD: 2 };

const CARD_FAIL: Record<string, string> = {
  card_rejected: "카드를 등록할 수 없습니다. 다른 카드로 다시 시도해 주십시오",
  payment_failed: "카드는 등록했지만 결제가 거절되었습니다. 다른 카드로 다시 시도해 주십시오",
  payment_in_progress: "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주십시오",
  not_activated: "결제는 되었지만 구독에 반영되지 않았습니다. 문의하기로 알려 주십시오",
};
const PLAN_FAIL: Record<string, string> = {
  same_plan: "이미 이용 중인 플랜입니다",
  card_required: "결제 카드를 먼저 등록해 주십시오",
  payment_in_progress: "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주십시오",
  payment_failed: "차액 결제가 거절되어 플랜을 바꾸지 않았습니다. 결제 카드를 확인해 주십시오",
  not_activated: "결제는 되었지만 플랜에 반영되지 않았습니다. 문의하기로 알려 주십시오",
};

function statusOf(v: View): { label: string; cls: string } {
  const s = v.subscription;
  if (v.access === "trial") return { label: "체험 중", cls: "b-info" };
  if (v.access === "grace") return { label: "결제 실패", cls: "b-fail" };
  if (v.access === "expired") return { label: "이용 기간 끝", cls: "b-gray" };
  if (s?.cancelAtPeriodEnd) return { label: "해지 예정", cls: "b-warn" };
  if (s?.status === "PAST_DUE") return { label: "결제 실패", cls: "b-fail" };
  return { label: "이용 중", cls: "b-done" };
}

export default function SubscriptionPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; view: View }>({ kind: "loading" });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [testMode, setTestMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "plan"; plan: Plan } | { kind: "cancel" } | null>(null);
  const reads = useLatestResponse();

  // 변경 뒤 다시 읽기에도 쓴다: 처음이 아니면 불러오는 화면을 띄우지 않고, 다시 읽기가 실패하면 지금 화면을 두고 알린다
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState({ kind: "loading" });
      const t = reads.next();
      const r = await api<View>("/api/seller/subscription");
      if (!r.ok) {
        if (!reads.failMatters(t)) return false;
        if (!reads.hasApplied()) setState({ kind: "error", status: r.status });
        return false;
      }
      if (reads.accept(t) === "apply") setState({ kind: "ok", view: r.data });
      return true;
    },
    [reads],
  );

  useEffect(() => {
    void load();
    void api<{ plans: Plan[] }>("/api/plans", { authRedirect: false }).then((r) => r.ok && setPlans(r.data.plans));
    void api<{ testMode?: boolean }>("/api/health", { authRedirect: false }).then((r) => r.ok && setTestMode(r.data.testMode === true));
  }, [load]);

  // 변경 요청 뒤에는 결과를 짐작하지 않고 서버 상태를 다시 읽는다. 다시 읽기가 실패하면 그렇게 알린다.
  const reread = async (done: string | null) => {
    const ok = await load(true);
    // 이용 상태(체험·이용 중·잠김)가 바뀌었을 수 있어 상단 띠·메뉴가 쓰는 /me도 다시 읽게 한다.
    // SellerShell은 창 포커스 때 /me를 다시 읽으므로(1초 안 중복은 한 번으로 모음) 그 신호를 보낸다.
    window.dispatchEvent(new Event("focus"));
    if (done) setToast(ok ? done : `${done} · 화면을 새로 불러오지 못했습니다. 새로고침해 주십시오`);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    setPending(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const registerCard = () =>
    run(async () => {
      // 테스트 서버의 가짜 결제 공급자는 어떤 인증 값이든 카드로 받는다(실제 카드·결제 없음)
      const r = await api<{ ok: true; charged: boolean }>("/api/seller/subscription/card", { method: "POST", body: { authKey: `test-${crypto.randomUUID()}` } });
      if (!r.ok) {
        if (r.error === "payment_pending") {
          setPending("결제 결과를 확인하고 있습니다. 잠시 후 이 화면에서 다시 확인해 주십시오");
          return reread(null);
        }
        setFailure(CARD_FAIL[r.error] ?? failMessage(r, "admin"));
        // 카드 등록과 결제는 따로 확정될 수 있어(카드만 바뀌고 결제가 거절 등) 실패여도 지금 상태를 다시 읽는다
        return reread(null);
      }
      await reread(r.data.charged ? "카드를 등록하고 결제했습니다" : "결제 카드를 등록했습니다");
    });

  const changePlan = (plan: Plan) =>
    run(async () => {
      const r = await api<PlanChange | { error: string }>("/api/seller/subscription/plan", { method: "POST", body: { planCode: plan.code } });
      setConfirm(null);
      if (!r.ok) {
        setFailure(PLAN_FAIL[r.error] ?? failMessage(r, "admin"));
        return reread(null);
      }
      // 202: 차액 결제 결과를 아직 모름(그동안 지금 플랜 그대로)
      if ("error" in r.data) {
        setPending("차액 결제 결과를 확인하고 있습니다. 확인될 때까지 지금 플랜을 그대로 이용합니다");
        return reread(null);
      }
      const d = r.data;
      const text =
        d.applied === "now"
          ? `「${plan.name}」으로 변경했습니다${d.charged > 0 ? ` · 차액 ${won(d.charged)} 결제` : ""}`
          : d.applied === "next_payment"
            ? `${DAY(d.effectiveAt)}부터 「${plan.name}」으로 변경됩니다`
            : "플랜 변경 예약을 취소했습니다";
      await reread(text);
    });

  const cancel = () =>
    run(async () => {
      const r = await api<{ ok: true; currentPeriodEnd: string | null }>("/api/seller/subscription/cancel", { method: "POST" });
      setConfirm(null);
      if (!r.ok) {
        setFailure(r.error === "not_subscribed" ? "해지할 구독이 없습니다" : failMessage(r, "admin"));
        return reread(null);
      }
      await reread(r.data.currentPeriodEnd ? `해지했습니다 · ${DAY(r.data.currentPeriodEnd)}까지 이용할 수 있습니다` : "해지했습니다");
    });

  const view = state.kind === "ok" ? state.view : null;
  const sub = view?.subscription ?? null;
  const live = !!sub && sub.status !== "CANCELED" && !sub.cancelAtPeriodEnd && view?.access !== "expired";
  const current = view?.plan?.code ?? null;
  const pendingPlan = sub?.pendingPlanCode && !sub.cancelAtPeriodEnd ? plans.find((p) => p.code === sub.pendingPlanCode) ?? { code: sub.pendingPlanCode, name: "다른 플랜" } : null;

  return (
    <>
      <Topbar crumb="설정 › 구독 · 결제" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">구독 · 결제</h1>
            <span className="t-l2 c-alt">요금제, 결제 카드, 청구 내역을 관리합니다.</span>
          </div>
        </div>

        {!view ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 403 ? <NoPermission need="대표자" /> : <ErrorState title="구독 정보를 불러오지 못했습니다" onRetry={() => void load()} />)}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            {failure && (
              <div className="msg msg-neg" role="alert">
                <span>
                  <b>처리하지 못했습니다.</b> {failure}
                </span>
              </div>
            )}
            {pending && (
              <div className="msg msg-cau" role="status">
                <span>{pending}</span>
                <button className="btn btn-sm btn-out" type="button" onClick={() => void reread(null)} disabled={busy}>
                  다시 확인
                </button>
              </div>
            )}

            <div className="sub-grid">
              <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="sub-plan">
                <div className="row" style={{ gap: 8, justifyContent: "space-between" }}>
                  <h2 className="t-hl1" id="sub-plan">
                    내 요금제
                  </h2>
                  <span className={`bdg ${statusOf(view).cls}`} data-testid="sub-status">
                    {statusOf(view).label}
                  </span>
                </div>
                {view.plan ? (
                  <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span className="t-h2">{view.plan.name}</span>
                    {/* nextAmount는 다음 결제 금액이라 하위 변경이 예약돼 있으면 바뀔 플랜 금액이다: 그때는 「다음 결제」 줄에만 보인다 */}
                    {!pendingPlan && (
                      <>
                        <span className="t-l1 fw6">월 {won(view.plan.nextAmount)}</span>
                        {view.plan.listPrice > view.plan.nextAmount && <s className="t-l2 c-alt">{won(view.plan.listPrice)}</s>}
                      </>
                    )}
                  </div>
                ) : (
                  <span className="t-l2 c-alt">요금제 정보가 없습니다. 문의하기로 알려 주십시오</span>
                )}
                <dl className="kv">
                  {view.access === "trial" && (
                    <>
                      <dt>체험 종료</dt>
                      <dd>{DAY(view.trialEndsAt)}</dd>
                    </>
                  )}
                  {sub?.currentPeriodEnd && (
                    <>
                      <dt>이용 기간</dt>
                      <dd>
                        {DAY(sub.currentPeriodStart)} ~ {DAY(sub.currentPeriodEnd)}
                      </dd>
                    </>
                  )}
                  {live && sub?.nextChargeAt && (
                    <>
                      <dt>다음 결제</dt>
                      <dd>
                        {DAY(sub.nextChargeAt)} · {won(view.plan?.nextAmount ?? 0)}
                      </dd>
                    </>
                  )}
                  {view.access === "grace" && sub?.graceUntil && (
                    <>
                      <dt>결제 확인 기한</dt>
                      <dd>{DAY(sub.graceUntil)}</dd>
                    </>
                  )}
                </dl>
                {sub?.cancelAtPeriodEnd && sub.currentPeriodEnd && (
                  <div className="msg msg-info t-l2" role="note">
                    <span>해지했습니다. {DAY(sub.currentPeriodEnd)}까지 이용할 수 있고, 그 뒤에는 결제되지 않습니다.</span>
                  </div>
                )}
                {view.access === "expired" && (
                  <div className="msg msg-neg t-l2" role="note">
                    <span>결제 카드를 등록하면 바로 결제되고 다시 이용할 수 있습니다.</span>
                  </div>
                )}
                {pendingPlan && (
                  <div className="msg msg-cau t-l2" role="note">
                    <span>
                      <b>변경 예정</b> {DAY(sub?.nextChargeAt ?? null)}부터 「{pendingPlan.name}」으로 바뀝니다.
                    </span>
                    {current && (
                      <button
                        className="btn btn-sm btn-out"
                        type="button"
                        disabled={busy}
                        onClick={() => void changePlan(plans.find((p) => p.code === current) ?? { code: current, name: view.plan?.name ?? "" })}
                      >
                        변경 취소
                      </button>
                    )}
                  </div>
                )}
              </section>

              <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="sub-card">
                <h2 className="t-hl1" id="sub-card">
                  결제 카드
                </h2>
                <span className="t-l1" data-testid="sub-card-label">
                  {sub?.cardLabel ?? "등록된 카드가 없습니다"}
                </span>
                <span className="t-c1 c-alt">카드 자동결제만 지원합니다. 매달 결제일에 등록한 카드로 결제됩니다.</span>
                {testMode ? (
                  <>
                    <button className="btn btn-sm" type="button" onClick={() => void registerCard()} disabled={busy}>
                      {busy ? "처리 중" : sub?.cardLabel ? "테스트 카드로 변경" : "테스트 카드 등록"}
                    </button>
                    <span className="t-c1 c-alt">테스트 서버입니다. 실제 카드 등록과 결제는 이루어지지 않습니다.</span>
                  </>
                ) : (
                  <>
                    <button className="btn btn-sm" type="button" disabled>
                      {sub?.cardLabel ? "카드 변경" : "카드 등록"}
                    </button>
                    <span className="t-c1 c-alt">카드 등록은 준비 중입니다.</span>
                  </>
                )}
              </section>
            </div>

            {plans.length > 0 && (
              <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="sub-plans">
                <h2 className="t-hl1" id="sub-plans">
                  플랜 변경
                </h2>
                <div className="sub-plans">
                  {plans.map((p) => {
                    const on = p.code === current;
                    return (
                      <div key={p.code} className={`sub-plan${on ? " on" : ""}`} data-testid="sub-plan">
                        {/* 가격은 적지 않는다: 공개 가격(/api/plans)은 신규 가입 기준이라 이 쇼핑몰의 실제 결제 금액(정가 적용 등)과 다를 수 있다 */}
                        <span className="t-l1 fw6">{p.name}</span>
                        {on ? (
                          <span className="bdg b-info nodot">이용 중</span>
                        ) : (
                          <button className="btn btn-sm btn-out" type="button" disabled={busy || pendingPlan?.code === p.code} onClick={() => setConfirm({ kind: "plan", plan: p })}>
                            {pendingPlan?.code === p.code ? "변경 예정" : "변경"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <span className="t-c1 c-alt">올리면 남은 기간 차액을 바로 결제하고, 내리면 다음 결제일부터 적용됩니다.</span>
              </section>
            )}

            <PaymentHistory payments={view.payments} />

            {live && (
              <section className="card pad-l row" style={{ gap: 12, justifyContent: "space-between", flexWrap: "wrap" }} aria-labelledby="sub-cancel">
                <div className="col" style={{ gap: 4 }}>
                  <h2 className="t-hl1" id="sub-cancel">
                    구독 해지
                  </h2>
                  <span className="t-l2 c-alt">해지해도 이번 이용 기간이 끝날 때까지는 그대로 이용할 수 있습니다.</span>
                </div>
                <button className="btn btn-sm btn-out" type="button" onClick={() => setConfirm({ kind: "cancel" })} disabled={busy}>
                  해지
                </button>
              </section>
            )}
          </div>
        )}
      </main>

      {confirm && view && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="sub-confirm-title">
          <div className="modal">
            <div className="modal-h">
              <h2 className="t-h2" id="sub-confirm-title">
                {confirm.kind === "cancel" ? "구독을 해지하시겠습니까?" : `「${confirm.plan.name}」으로 변경하시겠습니까?`}
              </h2>
              <span className="t-l2 c-alt">
                {confirm.kind === "cancel"
                  ? `${DAY(sub?.currentPeriodEnd ?? null)}까지 이용할 수 있고, 그 뒤에는 결제되지 않습니다.`
                  : (RANK[confirm.plan.code] ?? 0) > (RANK[current ?? ""] ?? 0)
                    ? "남은 이용 기간의 차액을 등록한 카드로 바로 결제합니다."
                    : "다음 결제일부터 적용됩니다. 그 전까지는 지금 플랜을 그대로 이용합니다."}
              </span>
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setConfirm(null)} disabled={busy}>
                취소
              </button>
              {confirm.kind === "cancel" ? (
                <button className="btn btn-neg" type="button" onClick={() => void cancel()} disabled={busy}>
                  {busy ? "해지 중" : "해지"}
                </button>
              ) : (
                <button className="btn" type="button" onClick={() => void changePlan(confirm.plan)} disabled={busy}>
                  {busy ? "변경 중" : "변경"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
