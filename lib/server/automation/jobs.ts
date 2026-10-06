import type { AutomationCustomerAction, AutomationJob, AutomationPayment, PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS } from "./config";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { alertCleanupNeeded, dbNow, endStateFor, expireCustomerWait, lockJob, writeJobEvent } from "./queue";
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
  // 「잠시 멈추기」(SA-152): 멈춘 상태면 paused=true·pausedAt, 멈춘 단계는 stepNumber(상태는 QUEUED로 보인다). 이어 하기로 풀린다
  paused: boolean;
  pausedAt: Date | null;
  // 「고객 확인 필요」 할 일 목록(SA-152): 고객 확인 대기(NEEDS_CUSTOMER)일 때만 5줄(로그인·2단계 인증·보안문자·앱 권한·OBS 도구), 그 밖에는 빈 배열.
  // done: 고객이 「완료」로 표시한 줄(표시용, 작업자 진행과 무관), current: 지금 작업자가 기다리는 줄(customerAction)
  customerChecklist: { action: AutomationCustomerAction; done: boolean; current: boolean }[];
  // 대기 순번·예상 시작(SA-152 「대기 중」): 대기열에서 순서를 기다리는 작업(QUEUED·멈추지 않음·아직 실행 전)만, 그 밖에는 null. 목록 조회에서는 계산하지 않아 null.
  queue: QueueEstimate | null;
  createdAt: Date;
  finishedAt: Date | null;
};
export type QueueEstimate = { ahead: number; etaMinutes: number };

// 할 일 목록의 고정 순서(정본 SA-152)
export const CUSTOMER_ACTION_ORDER: readonly AutomationCustomerAction[] = ["LOGIN", "TWO_FACTOR", "CAPTCHA", "PERMISSION_GRANT", "LOCAL_TOOL"];
// 예상 시작 계산: 최근 성공한 작업 중 실행에 쓴 시간(고객 대기 제외)의 중앙값을 한 작업 길이로 보고, 앞선 작업을 동시 실행 수(maxRunning)씩 묶어 센다. 성공 기록이 없으면 기본값.
export const DEFAULT_RUN_MINUTES = 10;
export const ETA_MIN_MINUTES = 1;
export const ETA_MAX_MINUTES = 24 * 60;

// 화면에 내보내는 실패 사유는 정해 둔 코드만. 실행기·외부 화면에서 온 원문(외부 쇼핑몰 플랫폼 이름 등)은
// 응답에 싣지 않는다(2026-10-04 대표님 결정: 외부 쇼핑몰 플랫폼 이름 화면 노출 금지). 원문은 작업 기록에만 남는다.
const PUBLIC_ERRORS = new Set([
  "payment_failed",
  "lease_expired",
  "customer_action_timeout",
  "cost_limit",
  "budget_limit",
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
  "pc_identity_invalid",
  "shop_identity_invalid",
  "executor_error",
  "start_deadline",
  "total_deadline",
  "payment_unresolved",
  "planner_timeout",
  "read_timeout",
  "state_save_timeout",
  "state_save_failed",
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
  paused: j.pausedAt !== null,
  pausedAt: j.pausedAt,
  customerChecklist: j.status === "NEEDS_CUSTOMER" ? CUSTOMER_ACTION_ORDER.map((action) => ({ action, done: j.customerActionsDone.includes(action), current: j.customerAction === action })) : [],
  queue: null,
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
  return { ...toView(j), queue: await queueEstimate(db, j) };
}

// 대기 순번·예상 시작. 순서는 작업자가 고르는 순서(runAfter, createdAt)와 같다. 같은 OBS 대상의 다른 작업을 기다리는 경우 등은 반영하지 않는 어림값이다.
async function queueEstimate(db: PrismaClient, j: AutomationJob): Promise<QueueEstimate | null> {
  if (j.status !== "QUEUED" || j.pausedAt || j.startedAt) return null;
  const [ahead, recent] = await Promise.all([
    db.automationJob.count({
      where: { status: "QUEUED", pausedAt: null, startedAt: null, id: { not: j.id }, OR: [{ runAfter: { lt: j.runAfter } }, { runAfter: j.runAfter, createdAt: { lt: j.createdAt } }] },
    }),
    db.automationJob.findMany({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, take: 20, select: { activeMsUsed: true } }),
  ]);
  const ms = recent.map((r) => r.activeMsUsed).filter((v) => v > 0).sort((a, b) => a - b);
  const medianMin = ms.length === 0 ? DEFAULT_RUN_MINUTES : ms[Math.floor(ms.length / 2)] / 60_000;
  const waves = Math.floor(ahead / Math.max(1, AUTOMATION_LIMITS.maxRunning)) + (ahead > 0 ? 1 : 0);
  const eta = Math.min(ETA_MAX_MINUTES, Math.max(ETA_MIN_MINUTES, Math.ceil(waves * medianMin)));
  return { ahead, etaMinutes: ahead === 0 ? 0 : eta };
}

// action_expired: 고객 행동 마감이 지나 재개할 수 없다(그 자리에서 실패·전액 환불 처리 대기로 끝냈다)
type ChangeResult = { ok: true; job: JobView } | { ok: false; reason: "invalid_state" | "action_expired" };

// 고객이 로그인·인증·권한 승인·로컬 도구 연결을 마쳤다: 대기열로 돌려 자동으로 이어 간다.
export async function resumeJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return change(db, ctx, jobId, "QUEUED", "automation.resume", (now) => ({ customerAction: null, actionDeadlineAt: null, customerActionsDone: [], runAfter: now }));
}

// 고객 확인 할 일 목록에서 한 줄을 「완료」로 표시한다(SA-152). 고객 확인 대기(NEEDS_CUSTOMER)일 때만, 같은 줄을 다시 눌러도 그대로(멱등).
// 표시용이라 작업자 진행·마감은 바꾸지 않는다(이어서 진행하기 = 재개가 대기열로 돌린다). 대표자·구독 관리 권한만. 아닌 상태는 409 invalid_state, 모르는 줄은 400 invalid_action.
export type MarkActionResult = { ok: true; job: JobView } | { ok: false; reason: "invalid_state" | "invalid_action" };
export async function markCustomerActionDone(db: PrismaClient, ctx: TenantContext, jobId: string, action: unknown): Promise<MarkActionResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  if (typeof action !== "string" || !(CUSTOMER_ACTION_ORDER as readonly string[]).includes(action)) return { ok: false, reason: "invalid_action" };
  const a = action as AutomationCustomerAction;
  const ok = await db.$transaction(async (tx) => {
    await lockJob(tx, jobId);
    const cur = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
    if (!cur) throw notFound();
    if (cur.status !== "NEEDS_CUSTOMER") return false;
    if (!cur.customerActionsDone.includes(a)) {
      await tx.automationJob.update({ where: { id: jobId }, data: { customerActionsDone: [...cur.customerActionsDone, a] } });
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "automation.action_done", targetType: "AutomationJob", targetId: jobId, after: { action: a } });
    }
    return true;
  });
  return ok ? { ok: true, job: await getJob(db, ctx, jobId) } : { ok: false, reason: "invalid_state" };
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
    // 취소 출처(정리 필요를 닫을 때 취소로 끝낼지를 이 값으로만 정한다)
    cancelRequestedAt: now,
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
  // 정리 필요(CLEANUP_NEEDED)는 마스터 관리자가 정리 뒤 닫을 때만 끝난다(closeCleanupNeeded). 판매자 취소로는 닫지 않는다
  const from = to === "QUEUED" ? (["NEEDS_CUSTOMER"] as const) : sourcesOf(to).filter((s) => s !== "CLEANUP_NEEDED");
  const result = await db.$transaction(async (tx) => {
    // 행을 잠가 읽은 상태와 실제로 바꾸는 상태를 같게 한다(작업자 전이와 겹쳐도 기록의 이전 상태가 맞도록)
    await lockJob(tx, jobId);
    const cur = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
    if (!cur) throw notFound();
    const now = await dbNow(tx);
    // 마감이 지난 대기 작업은 회수(reapExpired)를 기다리지 않고 같은 트랜잭션에서 회수와 같게 끝낸다(재개로 되살리지 않음)
    if (to === "QUEUED" && cur.status === "NEEDS_CUSTOMER" && cur.actionDeadlineAt && cur.actionDeadlineAt <= now) {
      await expireCustomerWait(tx, jobId, now);
      return "expired" as const;
    }
    // 바꾼 뒤 취소는 「정리 필요」로 멈춘다(endStateFor). 사람이 쇼핑몰 앱·웹훅·OBS를 정리한 뒤 마스터 관리자가 취소로 닫는다(cancelRequestedAt)
    const end = to === "CANCELED" ? endStateFor(cur, "CANCELED") : to;
    const r = await tx.automationJob.updateMany({
      where: { id: jobId, sellerId: ctx.sellerId, status: { in: [...from] }, ...(to === "QUEUED" ? { OR: [{ actionDeadlineAt: null }, { actionDeadlineAt: { gt: now } }] } : {}) },
      data: { ...data(now, cur), status: end, ...(end === "CLEANUP_NEEDED" ? { cleanupNeededAt: now, lastError: "canceled" } : {}) },
    });
    if (r.count !== 1) return false;
    const after = await tx.automationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (end === "CLEANUP_NEEDED") await alertCleanupNeeded(tx, cur, "canceled");
    await writeJobEvent(tx, after, cur.status, end, after.fencingToken, { by: ctx.actorId });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "AutomationJob", targetId: jobId, before: { status: cur.status }, after: { status: end } });
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

// 잠시 멈추기(SA-152): 대기열·실행 중·검증 중인 작업을 멈춘 단계 그대로 두고 작업자가 가져가지 못하게 한다. 대표자·구독 관리 권한만(취소·재개와 같음).
// 실행 중이면 취소와 같이 토큰을 올려 작업자의 다음 쓰기부터 막고(진행 중인 외부 행동 1개는 끝까지 갈 수 있다), 상태는 QUEUED로 돌려 단계(stepIndex)는 지키고 쓴 시간은 합계에 넣는다.
// 시작·전체·실행 시간 마감은 멈춰도 흐른다(지나면 reapExpired가 기존대로 닫고 환불 대기). 이미 멈췄거나 고객 행동 대기·끝난 작업은 409 invalid_state.
export async function pauseJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const ok = await db.$transaction(async (tx) => {
    await lockJob(tx, jobId);
    const cur = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
    if (!cur) throw notFound();
    if (cur.pausedAt || !(["QUEUED", "RUNNING", "VERIFYING"] as const).some((s) => s === cur.status)) return false;
    const now = await dbNow(tx);
    const leased = cur.status !== "QUEUED";
    const after = await tx.automationJob.update({
      where: { id: jobId },
      data: {
        pausedAt: now,
        status: "QUEUED",
        ...(leased
          ? {
              activeMsUsed: cur.activeMsUsed + (cur.runStartedAt ? Math.max(0, now.getTime() - cur.runStartedAt.getTime()) : 0),
              runStartedAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              fencingToken: { increment: 1 },
            }
          : {}),
      },
    });
    await writeJobEvent(tx, after, cur.status, "QUEUED", after.fencingToken, { reason: "paused", by: ctx.actorId });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "automation.pause", targetType: "AutomationJob", targetId: jobId, before: { status: cur.status, stepIndex: cur.stepIndex }, after: { status: "QUEUED", paused: true } });
    return true;
  });
  return ok ? { ok: true, job: await getJob(db, ctx, jobId) } : { ok: false, reason: "invalid_state" };
}

// 이어 하기(SA-152): 멈춘 작업을 풀어 바로 대기열로 돌린다. 멈춘 단계(stepIndex)부터 다시 시작한다. 멈춰 있지 않으면 409 invalid_state.
export async function continueJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const ok = await db.$transaction(async (tx) => {
    await lockJob(tx, jobId);
    const cur = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
    if (!cur) throw notFound();
    if (!cur.pausedAt || cur.status !== "QUEUED") return false;
    const now = await dbNow(tx);
    const after = await tx.automationJob.update({ where: { id: jobId }, data: { pausedAt: null, runAfter: now } });
    await writeJobEvent(tx, after, "QUEUED", "QUEUED", after.fencingToken, { reason: "continued", by: ctx.actorId });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "automation.continue", targetType: "AutomationJob", targetId: jobId, before: { paused: true }, after: { paused: false, stepIndex: cur.stepIndex } });
    return true;
  });
  return ok ? { ok: true, job: await getJob(db, ctx, jobId) } : { ok: false, reason: "invalid_state" };
}

// 작업 기록 시각표(SA-152). 상태가 바뀐 기록을 오래된 순으로. 화면이 문구로 바꾸도록 정해 둔 코드만 내보낸다:
// kind: payment_confirmed(결제 확인·작업 시작) · started(실행 시작) · needs_customer(고객 확인 대기) · resumed(고객 확인 뒤 이어 감) · verifying(테스트 검증) ·
//       step_done(N단계 완료, stepNumber가 끝낸 단계) · retry(다시 시도) · paused(잠시 멈춤) · continued(이어 하기) · succeeded · failed · canceled · cleanup_needed(정리 필요) · other.
// stepNumber: 그 기록 시점의 단계(1부터, 모르면 null). reason: 실패·재시도 사유 코드(publicError 허용 목록만, 원문·비밀값·작업자 식별자는 내보내지 않는다).
export type TimelineKind = "payment_confirmed" | "started" | "needs_customer" | "resumed" | "verifying" | "step_done" | "retry" | "paused" | "continued" | "succeeded" | "failed" | "canceled" | "cleanup_needed" | "other";
export type TimelineEntry = { at: Date; kind: TimelineKind; stepNumber: number | null; reason: string | null };

export function timelineKind(from: string | null, to: string, reason: unknown): TimelineKind {
  if (reason === "step_done") return "step_done";
  if (reason === "paused") return "paused";
  if (reason === "continued") return "continued";
  if (to === "QUEUED") return from === "AWAITING_PAYMENT" || from === null ? "payment_confirmed" : from === "NEEDS_CUSTOMER" ? "resumed" : "retry";
  if (to === "AWAITING_PAYMENT") return "other";
  const byTo: Partial<Record<string, TimelineKind>> = { RUNNING: "started", NEEDS_CUSTOMER: "needs_customer", VERIFYING: "verifying", SUCCEEDED: "succeeded", FAILED: "failed", CANCELED: "canceled", CLEANUP_NEEDED: "cleanup_needed" };
  return byTo[to] ?? "other";
}

export async function getJobTimeline(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<{ job: JobView; timeline: TimelineEntry[] }> {
  const job = await getJob(db, ctx, jobId);
  const events = await db.automationJobEvent.findMany({ where: { jobId, sellerId: ctx.sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 200 });
  const timeline = events.filter((e) => e.toStatus !== "AWAITING_PAYMENT").map((e) => {
    const d = (e.detail ?? {}) as { reason?: unknown; stepIndex?: unknown };
    const kind = timelineKind(e.fromStatus, e.toStatus, d.reason);
    const stepNumber = typeof d.stepIndex === "number" && d.stepIndex >= 0 ? Math.min(d.stepIndex + 1, STEPS.length) : null;
    // 사유는 끝나거나 다시 시도한 기록에만, 정해 둔 코드(publicError)로만 내보낸다
    const reason = (kind === "failed" || kind === "retry" || kind === "cleanup_needed" || kind === "canceled") && typeof d.reason === "string" ? publicError(d.reason) : null;
    return { at: e.createdAt, kind, stepNumber, reason };
  });
  return { job, timeline };
}
