"use client";

import { PageHead } from "../../../../../components/admin-ui";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { won } from "../../../../../components/seller/format";
import { formatDate } from "../../../../../lib/client/format";
import { useLatestResponse } from "../../../../../components/seller/latestResponse";
import { canCancelSubscription, cardRegistrationCharges, isCancelScheduled, planChangeState } from "../../../../../lib/server/billing/access";
import { type Payment } from "../../../../../components/seller/subscription/PaymentHistory";
import "../../../../../styles/seller-settings2.css";

// SA-090 구독 · 결제(대표자 전용). API: GET /api/seller/subscription, POST …/card · …/plan · …/cancel, GET /api/plans(바꿀 수 있는 플랜 이름).
// 카드 등록은 실제 결제 업체 창이 아직 없어 테스트 서버(GET /api/health의 testMode)에서만 가짜 카드로 연다(돈 이동 없음).

type Access = "trial" | "paid" | "charging" | "grace" | "expired";
type View = {
  access: Access;
  trialEndsAt: string | null;
  plan: { code: string; name: string; listPrice: number; salePrice: number; nextAmount: number; mailMonthlyQuota?: number; launchDiscount?: { active: boolean; endsAt: string | null } } | null;
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
    subscribedAt?: string | null;
    billingDay?: number | null;
    startedFromTrial?: boolean;
  } | null;
  payments: Payment[];
  billingRows?: BillingRow[];
};
type BillingRow = { id: string; kind: "SUBSCRIPTION" | "PRORATION" | "MESSAGE_CHARGE"; billingMonth: string; state: "SCHEDULED" | "PENDING" | "PAID" | "FAILED"; amount: number; at: string; receiptUrl: string | null };
type Plan = { code: string; name: string };
const ROW_STATE: Record<BillingRow["state"], { label: string; cls: string }> = {
  SCHEDULED: { label: "예정", cls: "b-info" },
  PENDING: { label: "확인 중", cls: "b-wait" },
  PAID: { label: "결제 완료", cls: "b-done" },
  FAILED: { label: "결제 실패", cls: "b-fail" },
};
const ROW_KIND: Record<BillingRow["kind"], string> = { SUBSCRIPTION: "월 구독", PRORATION: "이용권 변경 차액", MESSAGE_CHARGE: "발송·이용 충전 (선불)" };
const dotDay = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)).replace(/\.\s*/g, ".").replace(/\.$/, "");
const dotTime = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);
// 미리보기(GET …/plan/preview)의 플랜별 변경 결과. chargeNow는 지금 바로 낼 금액(원)이다.
type PlanPreview = { plans: { planCode: string; change: { ok: true; chargeNow: number } | { ok: false; reason: string } }[] };
// 확인 창의 금액: 미리보기를 읽는 중 · 읽음(chargeNow가 없으면 서버가 사유로 거절할 변경) · 읽지 못함
type Quote = { state: "loading" } | { state: "ok"; chargeNow: number | null } | { state: "error" };
type PlanChange = { ok: true; applied: "now" | "next_payment" | "canceled_pending"; charged: number; planCode: string; effectiveAt: string | null; remainingDays?: number | null };

const DAY = (iso: string | null) => (iso ? formatDate(iso, "-") : "-");

// 플랜 순위(planChange.ts와 같은 기준): 올리면 남은 기간 차액을 바로 결제, 내리면 다음 결제일부터
const RANK: Record<string, number> = { OVERLAY_ONLY: 1, INTEGRATED: 2, STANDARD: 2 };

const CARD_FAIL: Record<string, string> = {
  card_rejected: "카드를 등록할 수 없습니다. 다른 카드로 다시 시도해 주십시오",
  payment_failed: "카드는 등록했지만 결제가 거절되었습니다. 다른 카드로 다시 시도해 주십시오",
  payment_in_progress: "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주십시오",
  not_activated: "결제는 되었지만 구독에 반영되지 않았습니다. 문의하기로 알려 주십시오",
};
const PLAN_FAIL: Record<string, string> = {
  same_plan: "이미 이용 중인 이용권입니다",
  card_required: "결제 카드를 먼저 등록해 주십시오",
  payment_in_progress: "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주십시오",
  payment_failed: "차액 결제가 거절되어 이용권을 바꾸지 않았습니다. 결제 카드를 확인해 주십시오",
  not_activated: "결제는 되었지만 이용권에 반영되지 않았습니다. 문의하기로 알려 주십시오",
  cancel_scheduled: "해지 예정인 구독은 이용권을 바꿀 수 없습니다. 결제 카드를 다시 등록해 해지를 취소한 뒤 바꿔 주십시오",
};

const toDate = (iso: string | null) => (iso ? new Date(iso) : null);

// 서버 판정 함수(access.ts의 planChangeState)를 화면 값(문자열 시각)으로 부른다. 서버의 changePlan과 같은 기준이다.
function billingState(v: View, now = new Date()) {
  const s = v.subscription;
  return planChangeState(
    toDate(v.trialEndsAt),
    s ? { status: s.status, cancelAtPeriodEnd: s.cancelAtPeriodEnd, currentPeriodStart: toDate(s.currentPeriodStart), currentPeriodEnd: toDate(s.currentPeriodEnd) } : null,
    now,
  );
}

// 플랜 변경 확인 창 안내: 결제한 기간 중·결제 실패(유예가 끝났어도 해지 전이면)·체험 중·그 밖에 따라 적용 시점과 결제가 다르다.
// 결제가 필요한데 카드가 없으면 서버가 card_required로 거절하므로 확인 버튼을 막는다(blocked).
function planChangeNote(v: View, target: string): { text: string; blocked: boolean } {
  const { paidActive, pastDue, inTrial } = billingState(v);
  const up = (RANK[target] ?? 0) > (RANK[v.plan?.code ?? ""] ?? 0);
  const noCard = !v.subscription?.cardLabel;
  if (!up) return { text: paidActive || pastDue ? "다음 결제일부터 적용됩니다. 그 전까지는 지금 이용권을 그대로 씁니다." : "바로 적용됩니다. 결제는 없습니다.", blocked: false };
  if ((paidActive || pastDue || inTrial) && noCard) return { text: "올리려면 결제 카드를 먼저 등록해 주십시오.", blocked: true };
  if (paidActive) return { text: "남은 이용 기간의 차액을 등록한 카드로 바로 결제합니다. 차액이 없으면 결제 없이 바로 바뀝니다.", blocked: false };
  if (pastDue) return { text: "밀린 이번 기간 요금과 남은 기간 차액을 등록한 카드로 바로 결제합니다.", blocked: false };
  if (inTrial) return { text: "새 이용권 요금을 등록한 카드로 바로 결제하고, 오늘부터 새 이용 기간이 시작됩니다.", blocked: false };
  return { text: "바로 적용되고 지금은 결제되지 않습니다. 다음 결제부터 새 이용권 요금이 청구됩니다.", blocked: false };
}

// 카드 등록(교체) 확인 창 안내. 결제가 일어나거나 해지 예약이 풀릴 때만 확인을 거친다(null이면 확인 없이 진행).
function cardNote(v: View, now = new Date()): string | null {
  const s = v.subscription;
  const charges = cardRegistrationCharges(toDate(v.trialEndsAt), s ? { status: s.status, currentPeriodEnd: toDate(s.currentPeriodEnd) } : null, now);
  // 체험 중 해지는 서버가 바로 CANCELED로 바꾸므로, 「해지 예정」으로 보이는 상태(해지했지만 이용 기간 중)를 모두 포함한다
  const scheduled =
    isCancelScheduled(s ? { status: s.status, cancelAtPeriodEnd: s.cancelAtPeriodEnd, currentPeriodEnd: toDate(s.currentPeriodEnd) } : null, now) ||
    (!!s && !canCancelSubscription(s) && (v.access === "trial" || v.access === "paid"));
  const parts: string[] = [];
  if (scheduled) parts.push("해지를 취소하고 자동결제가 다시 켜집니다.");
  if (charges) parts.push(`등록하면 바로 ${won(v.plan?.nextAmount ?? 0)}을 결제하고 이용 기간이 시작됩니다.`);
  return parts.length ? parts.join(" ") : null;
}

// 해지하면 이용이 끝나는 때: 결제한 기간이 남았으면 그 끝, 아니면 체험 끝(체험 중), 둘 다 없으면 null(바로 해지)
function serviceEnd(v: View, now = Date.now()): string | null {
  const end = v.subscription?.currentPeriodEnd;
  if (end && new Date(end).getTime() > now) return end;
  if (v.trialEndsAt && new Date(v.trialEndsAt).getTime() > now) return v.trialEndsAt;
  return null;
}

function statusOf(v: View): { label: string; cls: string } {
  const s = v.subscription;
  // 해지했지만 체험·결제한 기간이 남아 이용 중이면 「해지 예정」
  if (s && !canCancelSubscription(s) && (v.access === "trial" || v.access === "paid")) return { label: "해지 예정", cls: "b-warn" };
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
  const [showPlans, setShowPlans] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "plan"; plan: Plan; quote: Quote; changed?: boolean } | { kind: "undo"; current: Plan; pendingName: string } | { kind: "cancel" } | { kind: "card"; note: string } | null>(null);
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
      if (reads.accept(t) === "apply") {
        setState({ kind: "ok", view: r.data });
        // 확인 중이던 결제가 서버에서 끝났으면(PENDING 결제가 없음) 「확인하고 있습니다」 안내를 거둔다
        if (!r.data.payments.some((p) => p.status === "PENDING")) setPending(null);
      }
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
      setConfirm(null);
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

  // 확인 창을 열 때와 금액이 바뀌었을 때 미리보기를 읽어 지금 낼 금액을 확인 창에 보인다
  const quotePlan = async (plan: Plan, changed = false) => {
    setConfirm({ kind: "plan", plan, quote: { state: "loading" }, changed });
    const r = await api<PlanPreview>("/api/seller/subscription/plan/preview");
    const change = r.ok ? r.data.plans.find((x) => x.planCode === plan.code)?.change : undefined;
    const quote: Quote = !r.ok || !change ? { state: "error" } : { state: "ok", chargeNow: change.ok ? change.chargeNow : null };
    // 그사이 창을 닫았거나 다른 플랜으로 바뀌었으면 덮지 않는다
    setConfirm((c) => (c && c.kind === "plan" && c.plan.code === plan.code ? { kind: "plan", plan, quote, changed } : c));
  };

  const changePlan = (plan: Plan, expectedAmount: number | null) =>
    run(async () => {
      const r = await api<PlanChange | { error: string }>("/api/seller/subscription/plan", {
        method: "POST",
        body: expectedAmount === null ? { planCode: plan.code } : { planCode: plan.code, expectedAmount },
      });
      // 확인받은 금액과 지금 낼 금액이 달라졌다: 아무것도 바뀌지 않았으니 창을 두고 새 금액을 다시 보여 준다
      if (!r.ok && r.error === "amount_changed") {
        await Promise.all([quotePlan(plan, true), reread(null)]);
        return;
      }
      setConfirm(null);
      if (!r.ok) {
        setFailure(PLAN_FAIL[r.error] ?? failMessage(r, "admin"));
        return reread(null);
      }
      // 202: 차액 결제 결과를 아직 모름(그동안 지금 플랜 그대로)
      if ("error" in r.data) {
        setPending("차액 결제 결과를 확인하고 있습니다. 확인될 때까지 지금 이용권을 그대로 씁니다");
        return reread(null);
      }
      const d = r.data;
      const text =
        d.applied === "now"
          ? `「${plan.name}」으로 바꿨습니다${d.charged > 0 ? ` · 차액 ${won(d.charged)} 결제` : ""}`
          : d.applied === "next_payment"
            ? `${DAY(d.effectiveAt)}부터 「${plan.name}」으로 바뀝니다`
            : "이용권 바꾸기 예약을 취소했습니다";
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
  // 해지 가능 여부는 서버(cancelSubscription)와 같은 기준. 이용 기간이 끝난 결제 실패 구독도 해지할 수 있다.
  const live = canCancelSubscription(sub);
  const endsAt = view ? serviceEnd(view) : null;
  const current = view?.plan?.code ?? null;
  // 해지 예약 중에는 플랜을 바꿀 수 없다(서버 changePlan도 cancel_scheduled로 거절, 같은 판정 함수)
  const canceling = isCancelScheduled(sub ? { status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, currentPeriodEnd: toDate(sub.currentPeriodEnd) } : null, new Date());
  // 카드 등록 버튼: 결제가 일어나거나 해지 예약이 풀리면 확인 창을 먼저 띄운다
  const askCard = () => {
    const note = view ? cardNote(view) : null;
    setConfirm({ kind: "card", note: note ?? "등록한 카드로 매달 자동 결제됩니다." });
  };
  const pendingPlan = sub?.pendingPlanCode && !sub.cancelAtPeriodEnd ? plans.find((p) => p.code === sub.pendingPlanCode) ?? { code: sub.pendingPlanCode, name: "다른 이용권" } : null;

  return (
    <>
      <Topbar crumb="설정 › 구독 · 결제" />
      <main className="main">
        <PageHead
          title={<>구독 · 결제</>}
          description={<>이용권과 결제 수단을 관리하고 청구 내역을 확인합니다.</>}
          actions={<>{view && (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <a className="btn btn-out" href="/pricing">
                요금 안내
              </a>
              {plans.length > 0 && (
                <button className="btn btn-out" type="button" aria-expanded={showPlans} onClick={() => setShowPlans((v) => !v)}>
                  이용권 바꾸기
                </button>
              )}
              {live && (
                <button className="btn btn-out" type="button" onClick={() => setConfirm({ kind: "cancel" })} disabled={busy}>
                  구독 해지
                </button>
              )}
            </div>
          )}</>}
        />

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

            <h2 className="t-hl1 sub-sec" id="sub-plan">
              내 이용권
            </h2>
            {view.plan ? (
              <div className="card pad row sub-box">
                <div className="col" style={{ gap: 2 }}>
                  <span className="row" style={{ gap: 8, alignItems: "center" }}>
                    <b className="t-l1">{view.plan.name}</b>
                    <span className={`bdg ${statusOf(view).cls}`} data-testid="sub-status">
                      {statusOf(view).label}
                    </span>
                  </span>
                  {view.plan.listPrice > view.plan.nextAmount && <span className="t-c1 c-alt">정가 월 {won(view.plan.listPrice)}</span>}
                </div>
                {/* nextAmount는 다음 결제 금액이라 하위 변경이 예약돼 있으면 바뀔 플랜 금액이다: 그때는 「다음 결제일」 칸에만 보인다 */}
                {!pendingPlan && (
                  <span className="t-hl1 sub-price">
                    {won(view.plan.nextAmount)}
                    <small className="t-c1 c-alt fw5"> / 월 · 부가세 포함{view.plan.launchDiscount?.active ? " · 런칭 할인가" : ""}</small>
                  </span>
                )}
                {view.plan.launchDiscount?.active && (
                  <span className="t-c1 c-alt sub-box-note">
                    지금은 런칭 할인가로 결제됩니다. 할인이 끝나는 날짜와 그 뒤 금액(정가 월 {won(view.plan.listPrice)})은 정해지면 30일 전에 알려 드립니다.
                  </span>
                )}
              </div>
            ) : (
              <div className="card pad">
                <span className="t-l2 c-alt">이용권 정보가 없습니다. 문의하기로 알려 주십시오</span>
                <span className="bdg b-wait" data-testid="sub-status" style={{ marginLeft: 8 }}>
                  {statusOf(view).label}
                </span>
              </div>
            )}
            <table className="sub-ft">
              <tbody>
                <tr>
                  <th>구독 시작</th>
                  <td>
                    {view.access === "trial"
                      ? `체험 중 · ${DAY(view.trialEndsAt)}까지${view.plan ? ` · 끝나면 ${view.plan.name}으로 첫 결제` : ""}`
                      : sub?.subscribedAt
                        ? `${dotDay(sub.subscribedAt)} · ${sub.startedFromTrial ? "오버레이 전용 7일 체험 뒤 " : ""}${view.plan?.name ?? ""}으로 시작`
                        : "-"}
                  </td>
                  <th>다음 결제일</th>
                  <td>
                    {live && sub?.nextChargeAt ? (
                      <>
                        <b>{dotDay(sub.nextChargeAt)}</b> · {won(view.plan?.nextAmount ?? 0)}
                      </>
                    ) : (
                      "-"
                    )}
                    {sub?.currentPeriodEnd && !live ? <span className="t-c1 c-alt"> 이용 기간 {DAY(sub.currentPeriodStart)} ~ {DAY(sub.currentPeriodEnd)}</span> : null}
                    {view.access === "grace" && sub?.graceUntil ? <span className="t-c1 c-alt"> 결제 확인 기한 {DAY(sub.graceUntil)}</span> : null}
                  </td>
                </tr>
                <tr>
                  <th>할인 종료</th>
                  <td>
                    {view.plan?.launchDiscount?.active
                      ? view.plan.launchDiscount.endsAt
                        ? DAY(view.plan.launchDiscount.endsAt)
                        : "아직 정해지지 않았습니다 · 정해지면 30일 전에 알림톡과 메일로 알려 드립니다"
                      : "-"}
                  </td>
                  <th>할인이 끝나면</th>
                  <td>{view.plan?.launchDiscount?.active ? `정가 월 ${won(view.plan.listPrice)}` : "-"}</td>
                </tr>
                <tr>
                  <th>월 무료 메일</th>
                  <td>
                    {view.plan?.mailMonthlyQuota !== undefined
                      ? `주문 · 배송 안내 메일 월 ${view.plan.mailMonthlyQuota.toLocaleString("ko-KR")}통 (넘는 발송 · 알림톡 · 문자는 발송·이용 충전 잔액에서 차감)`
                      : "-"}
                  </td>
                  <th>청구 주기</th>
                  <td>{sub?.billingDay ? `매월 ${sub.billingDay}일 · 카드 자동결제` : "-"}</td>
                </tr>
              </tbody>
            </table>
            {sub && !live && endsAt && (
              <div className="msg msg-info t-l2" role="note">
                <span>해지했습니다. {DAY(endsAt)}까지 이용할 수 있고, 그 뒤에는 결제되지 않습니다.</span>
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
                  <b>바뀔 예정</b> {DAY(sub?.nextChargeAt ?? null)}부터 「{pendingPlan.name}」으로 바뀝니다.
                </span>
                {current && (
                  <button
                    className="btn btn-sm btn-out"
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirm({ kind: "undo", current: plans.find((p) => p.code === current) ?? { code: current, name: view.plan?.name ?? "" }, pendingName: pendingPlan.name })}
                  >
                    바꾸기 취소하기
                  </button>
                )}
              </div>
            )}
            <div className="card pad col" style={{ gap: 4 }}>
              <b className="t-l1">해지 · 이용권 변경 안내</b>
              <span className="t-l2 c-neu">해지하면 이번 결제 기간이 끝날 때까지 쓸 수 있고, 다음 결제부터 청구하지 않습니다 · 이미 낸 구독료는 남은 날짜만큼 돌려드리지 않습니다</span>
              <span className="t-l2 c-neu">올리면 남은 기간 차액을 바로 결제하고, 내리면 다음 결제일부터 바뀝니다</span>
              <span className="t-l2 c-neu">런칭 할인가는 계정당 한 번입니다 · 해지한 뒤 다시 구독하면 적용되지 않습니다</span>
            </div>

            {showPlans && plans.length > 0 && (
              <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="sub-plans">
                <h2 className="t-hl1" id="sub-plans">
                  이용권 바꾸기
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
                          <button className="btn btn-sm btn-out" type="button" disabled={busy || canceling || pendingPlan?.code === p.code} onClick={() => void quotePlan(p)}>
                            {pendingPlan?.code === p.code ? "바꾸기 예정" : "바꾸기"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <span className="t-c1 c-alt">
                  {canceling ? "해지 예정인 구독은 이용권을 바꿀 수 없습니다." : "위 이용권으로 올리면 남은 기간 차액을 바로 결제하고, 내리면 다음 결제일부터 바뀝니다."}
                </span>
              </section>
            )}

            <h2 className="t-hl1 sub-sec" id="sub-card">
              결제 수단
            </h2>
            <table className="sub-ft">
              <tbody>
                <tr>
                  <th>카드</th>
                  <td>
                    <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span data-testid="sub-card-label">{sub?.cardLabel ?? "등록된 카드가 없습니다"}</span>
                      {sub?.cardLabel && <span className="bdg b-info nodot">기본 수단</span>}
                      {testMode ? (
                        <button className="btn btn-sm btn-out" type="button" onClick={askCard} disabled={busy}>
                          {busy ? "처리 중" : sub?.cardLabel ? "카드 변경하기" : "카드 등록하기"}
                        </button>
                      ) : (
                        <button className="btn btn-sm btn-out" type="button" disabled>
                          {sub?.cardLabel ? "카드 변경하기" : "카드 등록하기"}
                        </button>
                      )}
                    </span>
                    <span className="t-c1 c-alt sub-hint">
                      구독료는 카드 자동결제로만 받습니다 (파트너스 쇼핑몰 PG와 별개) · 결제에 실패하면 하루 간격으로 3번 다시 시도합니다 · 실패한 날부터 7일 유예, 그 뒤에는 잠깁니다
                    </span>
                    <span className="t-c1 c-alt sub-hint">
                      {testMode ? "테스트 서버입니다. 실제 카드 등록과 결제는 이루어지지 않습니다." : "카드 등록은 준비 중입니다."}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>

            <div className="row between sub-sec">
              <h2 className="t-hl1" id="sub-history">
                청구 내역
              </h2>
              <a className="btn btn-sm btn-out" href="/api/seller/subscription/payments/export" download>
                전체 내보내기
              </a>
            </div>
            {(view.billingRows ?? []).length === 0 ? (
              <div className="card">
                <div className="st">
                  <span className="t">청구 내역이 없습니다</span>
                </div>
              </div>
            ) : (
              <div className="card" style={{ overflowX: "auto" }}>
                <table className="tbl sub-tbl">
                  <thead>
                    <tr>
                      <th>청구월</th>
                      <th>항목</th>
                      <th>금액</th>
                      <th>결제일</th>
                      <th>상태</th>
                      <th>매출전표</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(view.billingRows ?? []).map((r) => {
                      const url = safeUrl(r.receiptUrl);
                      return (
                        <tr key={r.id} data-testid={r.state === "SCHEDULED" ? "sub-scheduled" : "sub-payment"}>
                          <td className="num">{r.billingMonth.replace("-", ".")}</td>
                          <td className="col-text">
                            {ROW_KIND[r.kind]}
                            {r.kind === "MESSAGE_CHARGE" && <div className="t-c1 c-alt">알림톡 · 문자 · 대량 메일 · 제공량 넘긴 거래 메일 차감용 · 내역은 발송·이용 충전에서</div>}
                          </td>
                          <td className="num">{won(r.amount)}</td>
                          <td className="num">{r.state === "SCHEDULED" ? `예정 ${dotDay(r.at)}` : `${dotDay(r.at)} ${dotTime(r.at)}`}</td>
                          <td>
                            <span className={`bdg ${ROW_STATE[r.state].cls}`}>{ROW_STATE[r.state].label}</span>
                          </td>
                          <td>
                            {url ? (
                              <a className="btn btn-sm btn-out" href={url} target="_blank" rel="noopener noreferrer">
                                매출전표
                              </a>
                            ) : r.state === "SCHEDULED" || r.state === "PENDING" ? (
                              <span className="t-c1 c-alt">결제 후 발행</span>
                            ) : (
                              <span className="c-alt">-</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <span className="t-c1 c-alt">
              카드 매출전표는 줄마다 내려받을 수 있습니다 · 구독료 세금계산서는 따로 발행하지 않습니다 · 발송·이용 충전은 구독료와 별도로 충전할 때 결제되고 사용 내역은 「발송·이용 충전」에서 봅니다
            </span>

            <h2 className="t-hl1 sub-sec">구독 상태 안내</h2>
            <div className="card" style={{ overflowX: "auto" }}>
              <table className="tbl sub-tbl">
                <thead>
                  <tr>
                    <th style={{ width: 100 }}>상태</th>
                    <th>설명</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span className="bdg b-info">체험 중</span>
                    </td>
                    <td className="col-text">오버레이 전용만 승인일부터 7일 · 모든 기능 · 끝나면 런칭 할인가로 첫 결제</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="bdg b-done">이용 중</span>
                    </td>
                    <td className="col-text">정상 결제</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="bdg b-fail">연체</span>
                    </td>
                    <td className="col-text">결제 실패 후 하루 간격 3번 재시도 · 실패한 날부터 7일 유예 · 7일이 지나면 쇼핑몰과 방송 화면이 멈춥니다</td>
                  </tr>
                  <tr>
                    <td>
                      <span className="bdg b-cancel">해지</span>
                    </td>
                    <td className="col-text">잠긴 지 30일이 지나면 자동 해지 · 해지 뒤 90일 보관 후 삭제 · 그 안에 다시 구독하면 그대로 돌아옵니다</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>

      {confirm && view && (
        <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="sub-confirm-title">
          <div className="modal">
            <div className="modal-h">
              <h2 className="t-h2" id="sub-confirm-title">
                {confirm.kind === "cancel" ? "구독을 해지하시겠습니까?" : confirm.kind === "undo" ? "이용권 바꾸기를 취소하시겠습니까?" : confirm.kind === "card" ? "결제 카드를 등록하시겠습니까?" : `「${confirm.plan.name}」으로 바꾸시겠습니까?`}
              </h2>
              <span className="t-l2 c-alt">
                {confirm.kind === "cancel"
                  ? endsAt
                    ? `${DAY(endsAt)}까지 이용할 수 있고, 그 뒤에는 결제되지 않습니다.`
                    : "바로 해지되고 더 이상 결제되지 않습니다."
                  : confirm.kind === "undo"
                    ? `${DAY(sub?.nextChargeAt ?? null)}에 「${confirm.pendingName}」으로 바뀌는 예약이 없어지고 지금 이용권을 계속 씁니다`
                  : confirm.kind === "card"
                    ? confirm.note
                    : planChangeNote(view, confirm.plan.code).text}
              </span>
              {confirm.kind === "plan" && (
                <span className="t-l2 fw6" data-testid="sub-quote" role="status">
                  {confirm.changed && <>금액이 바뀌었습니다. 다시 확인해 주십시오. </>}
                  {confirm.quote.state === "loading"
                    ? "결제 금액을 확인하고 있습니다"
                    : confirm.quote.state === "error"
                      ? "결제 금액을 확인하지 못했습니다. 닫고 다시 시도해 주십시오"
                      : confirm.quote.chargeNow !== null && confirm.quote.chargeNow > 0
                        ? `지금 결제 금액 ${won(confirm.quote.chargeNow)}`
                        : confirm.quote.chargeNow === 0
                          ? "지금 결제되는 금액은 없습니다"
                          : null}
                </span>
              )}
            </div>
            <div className="modal-f">
              <button className="btn btn-out" type="button" onClick={() => setConfirm(null)} disabled={busy}>
                취소
              </button>
              {confirm.kind === "cancel" ? (
                <button className="btn btn-neg" type="button" onClick={() => void cancel()} disabled={busy}>
                  {busy ? "해지 중" : "구독 해지하기"}
                </button>
              ) : confirm.kind === "undo" ? (
                <button className="btn" type="button" onClick={() => void changePlan(confirm.current, null)} disabled={busy}>
                  {busy ? "처리 중" : "바꾸기 취소하기"}
                </button>
              ) : confirm.kind === "card" ? (
                <button className="btn" type="button" onClick={() => void registerCard()} disabled={busy}>
                  {busy ? "처리 중" : "카드 등록하기"}
                </button>
              ) : (
                <button className="btn" type="button" onClick={() => void changePlan(confirm.plan, confirm.quote.state === "ok" ? confirm.quote.chargeNow : null)}
                  disabled={busy || confirm.quote.state !== "ok" || planChangeNote(view, confirm.plan.code).blocked}
                >
                  {busy ? "바꾸는 중" : "이용권 바꾸기"}
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
