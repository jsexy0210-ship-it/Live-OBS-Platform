import type { AutomationJob, AutomationPayment, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { dbNow, flagCleanupIfChanged, lockJob, markRefundPending, writeJobEvent } from "./queue";
import { sourcesOf } from "./states";
import { STEPS } from "./steps";

// 판매자 화면용 작업 조회·재개·취소. sellerId는 세션 컨텍스트에서만 얻고, 다른 판매자 작업은 존재 여부도 알리지 않는다(404).
// 1차는 대표자 전용(결제와 같은 권한). 직원에게 열지는 판단 필요.

export type JobView = {
  id: string;
  kind: AutomationJob["kind"];
  status: AutomationJob["status"];
  // 무료 재연결은 결제가 없다(null, 금액 0)
  paymentStatus: AutomationPayment["status"] | null;
  amount: number;
  step: string | null;
  stepNumber: number;
  stepCount: number;
  customerAction: AutomationJob["customerAction"];
  actionDeadlineAt: Date | null;
  lastError: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  finishedAt: Date | null;
};

// 화면에 내보내는 실패 사유는 정해 둔 코드만. 실행기·외부 화면에서 온 원문(외부 쇼핑몰 플랫폼 이름 등)은
// 응답에 싣지 않는다(2026-10-04 대표님 결정: 외부 쇼핑몰 플랫폼 이름 화면 노출 금지). 원문은 작업 기록에만 남는다.
const PUBLIC_ERRORS = new Set([
  "payment_failed",
  "lease_expired",
  "customer_action_timeout",
  "cost_limit",
  "reconnect_target_mismatch",
  "reconnect_target_unverified",
  "verification_missing",
  "worker_error",
  "run_time_limit",
  "obs_target_busy",
  "obs_target_changed",
  "playbook_version_changed",
  "playbook_not_verified",
  "shop_identity_unverified",
  "pairing_mismatch",
  "page_mismatch",
  "pc_identity_unverified",
]);
const STEP_KEYS = new Set(STEPS.map((s) => s.key));

export function publicError(raw: string | null): string | null {
  if (!raw) return null;
  if (PUBLIC_ERRORS.has(raw)) return raw;
  if (raw.startsWith("unsafe_action:")) return "unsafe_action";
  const [head, step] = raw.split(":");
  if (head === "step_action_limit" && STEP_KEYS.has(step)) return raw;
  return "step_failed";
}

const toView = (j: AutomationJob & { payment: AutomationPayment | null }): JobView => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  paymentStatus: j.payment?.status ?? null,
  amount: j.payment?.amount ?? 0,
  step: STEPS[j.stepIndex]?.key ?? null,
  stepNumber: Math.min(j.stepIndex + 1, STEPS.length),
  stepCount: STEPS.length,
  customerAction: j.customerAction,
  actionDeadlineAt: j.actionDeadlineAt,
  lastError: publicError(j.lastError),
  verifiedAt: j.verifiedAt,
  createdAt: j.createdAt,
  finishedAt: j.finishedAt,
});

export async function listJobs(db: PrismaClient, ctx: TenantContext): Promise<JobView[]> {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const rows = await db.automationJob.findMany({ where: { sellerId: ctx.sellerId }, include: { payment: true }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.map(toView);
}

export async function getJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<JobView> {
  requireSellerRead(ctx, "SUBSCRIPTION_MANAGE");
  const j = await db.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId }, include: { payment: true } });
  if (!j) throw notFound();
  return toView(j);
}

// action_expired: 고객 행동 마감이 지나 재개할 수 없다(그 자리에서 실패·전액 환불 처리 대기로 끝냈다)
type ChangeResult = { ok: true; job: JobView } | { ok: false; reason: "invalid_state" | "action_expired" };

// 고객이 로그인·인증·권한 승인·로컬 도구 연결을 마쳤다: 대기열로 돌려 자동으로 이어 간다.
export async function resumeJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return change(db, ctx, jobId, "QUEUED", "automation.resume", (now) => ({ customerAction: null, actionDeadlineAt: null, runAfter: now }));
}

// 취소: 실행 중이어도 토큰을 올려 작업자의 다음 쓰기를 막는다. 결제 환불은 자동으로 하지 않는다(환불 조건은 판단 필요).
export async function cancelJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return change(db, ctx, jobId, "CANCELED", "automation.cancel", (now, cur) => ({
    // 실행 중이었으면 쓴 시간을 합계에 넣는다
    activeMsUsed: cur.activeMsUsed + (cur.runStartedAt ? Math.max(0, now.getTime() - cur.runStartedAt.getTime()) : 0),
    runStartedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    customerAction: null,
    actionDeadlineAt: null,
    finishedAt: now,
    fencingToken: { increment: 1 },
  }));
}

async function change(
  db: PrismaClient,
  ctx: TenantContext,
  jobId: string,
  to: "QUEUED" | "CANCELED",
  action: string,
  data: (now: Date, cur: AutomationJob) => Parameters<PrismaClient["automationJob"]["updateMany"]>[0]["data"],
): Promise<ChangeResult> {
  const from = to === "QUEUED" ? (["NEEDS_CUSTOMER"] as const) : sourcesOf(to);
  const result = await db.$transaction(async (tx) => {
    // 행을 잠가 읽은 상태와 실제로 바꾸는 상태를 같게 한다(작업자 전이와 겹쳐도 기록의 이전 상태가 맞도록)
    await lockJob(tx, jobId);
    const cur = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
    if (!cur) throw notFound();
    const now = await dbNow(tx);
    // 마감이 지난 대기 작업은 회수(reapExpired)를 기다리지 않고 같은 트랜잭션에서 회수와 같게 끝낸다(재개로 되살리지 않음)
    if (to === "QUEUED" && cur.status === "NEEDS_CUSTOMER" && cur.actionDeadlineAt && cur.actionDeadlineAt <= now) {
      const failed = await tx.automationJob.update({
        where: { id: jobId },
        data: { status: "FAILED", lastError: "customer_action_timeout", finishedAt: now, customerAction: null, actionDeadlineAt: null },
      });
      await writeJobEvent(tx, failed, "NEEDS_CUSTOMER", "FAILED", failed.fencingToken, { reason: "customer_action_timeout" });
      await markRefundPending(tx, failed, "customer_action_timeout", now);
      await flagCleanupIfChanged(tx, failed, "customer_action_timeout", now);
      return "expired" as const;
    }
    const r = await tx.automationJob.updateMany({
      where: { id: jobId, sellerId: ctx.sellerId, status: { in: [...from] }, ...(to === "QUEUED" ? { OR: [{ actionDeadlineAt: null }, { actionDeadlineAt: { gt: now } }] } : {}) },
      data: { ...data(now, cur), status: to },
    });
    if (r.count !== 1) return false;
    const after = await tx.automationJob.findUniqueOrThrow({ where: { id: jobId } });
    // 바꾼 뒤 취소면 정리 필요 표시·마스터 알림(사람이 쇼핑몰 앱·웹훅·OBS를 정리)
    if (to === "CANCELED") await flagCleanupIfChanged(tx, cur, "canceled", now);
    await writeJobEvent(tx, after, cur.status, to, after.fencingToken, { by: ctx.actorId });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "AutomationJob", targetId: jobId, before: { status: cur.status }, after: { status: to } });
    return true;
  });
  if (result === "expired") return { ok: false, reason: "action_expired" };
  return result ? { ok: true, job: await getJob(db, ctx, jobId) } : { ok: false, reason: "invalid_state" };
}

export type RefundRequestResult = { ok: true; job: JobView } | { ok: false; reason: "not_refundable" };

// 환불 요청(확정 ②). 대상: 결제 완료(PAID)이고, 작업이 실패로 끝났거나(성공 기준 미통과 — 지원으로도 해결 안 됨)
// 연결을 시작하기 전에 취소된 경우. 연결을 시작한 뒤 취소(단순 변심)와 완료된 작업은 환불하지 않는다.
// 결과는 환불 처리 대기(REFUND_PENDING)까지다. 실제 PG 환불 실행은 대표님 승인 대상이라 여기서 하지 않는다.
export async function requestRefund(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<RefundRequestResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const ok = await db.$transaction(async (tx) => {
    const j = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId }, include: { payment: true } });
    if (!j) throw notFound();
    const reason = j.status === "FAILED" ? "failed" : j.status === "CANCELED" && !j.startedAt ? "canceled_before_start" : null;
    if (!reason || !j.payment) return false;
    const now = await dbNow(tx);
    const r = await tx.automationPayment.updateMany({
      where: { id: j.payment.id, sellerId: ctx.sellerId, status: "PAID" },
      data: { status: "REFUND_PENDING", refundReason: reason, refundRequestedAt: now },
    });
    if (r.count !== 1) return false;
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "automation.refund_request",
      targetType: "AutomationPayment",
      targetId: j.payment.id,
      after: { jobId, reason, amount: j.payment.amount },
    });
    return true;
  });
  return ok ? { ok: true, job: await getJob(db, ctx, jobId) } : { ok: false, reason: "not_refundable" };
}
