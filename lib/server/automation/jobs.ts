import type { AutomationJob, AutomationPayment, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { dbNow, writeJobEvent } from "./queue";
import { sourcesOf } from "./states";
import { STEPS } from "./steps";

// 판매자 화면용 작업 조회·재개·취소. sellerId는 세션 컨텍스트에서만 얻고, 다른 판매자 작업은 존재 여부도 알리지 않는다(404).
// 1차는 대표자 전용(결제와 같은 권한). 직원에게 열지는 판단 필요.

export type JobView = {
  id: string;
  status: AutomationJob["status"];
  paymentStatus: AutomationPayment["status"];
  amount: number;
  step: string | null;
  stepNumber: number;
  stepCount: number;
  customerAction: AutomationJob["customerAction"];
  actionDeadlineAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

const toView = (j: AutomationJob & { payment: AutomationPayment }): JobView => ({
  id: j.id,
  status: j.status,
  paymentStatus: j.payment.status,
  amount: j.payment.amount,
  step: STEPS[j.stepIndex]?.key ?? null,
  stepNumber: Math.min(j.stepIndex + 1, STEPS.length),
  stepCount: STEPS.length,
  customerAction: j.customerAction,
  actionDeadlineAt: j.actionDeadlineAt,
  lastError: j.lastError,
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

type ChangeResult = { ok: true; job: JobView } | { ok: false; reason: "invalid_state" };

// 고객이 로그인·인증·권한 승인·로컬 도구 연결을 마쳤다: 대기열로 돌려 자동으로 이어 간다.
export async function resumeJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return change(db, ctx, jobId, "QUEUED", "automation.resume", (now) => ({ customerAction: null, actionDeadlineAt: null, runAfter: now }));
}

// 취소: 실행 중이어도 토큰을 올려 작업자의 다음 쓰기를 막는다. 결제 환불은 자동으로 하지 않는다(환불 조건은 판단 필요).
export async function cancelJob(db: PrismaClient, ctx: TenantContext, jobId: string): Promise<ChangeResult> {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  return change(db, ctx, jobId, "CANCELED", "automation.cancel", (now) => ({
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
  data: (now: Date) => Parameters<PrismaClient["automationJob"]["updateMany"]>[0]["data"],
): Promise<ChangeResult> {
  const from = to === "QUEUED" ? (["NEEDS_CUSTOMER"] as const) : sourcesOf(to);
  const result = await db.$transaction(async (tx) => {
    const cur = await tx.automationJob.findFirst({ where: { id: jobId, sellerId: ctx.sellerId } });
    if (!cur) throw notFound();
    const now = await dbNow(tx);
    const r = await tx.automationJob.updateMany({ where: { id: jobId, sellerId: ctx.sellerId, status: { in: [...from] } }, data: { ...data(now), status: to } });
    if (r.count !== 1) return false;
    const after = await tx.automationJob.findUniqueOrThrow({ where: { id: jobId } });
    await writeJobEvent(tx, after, cur.status, to, after.fencingToken, { by: ctx.actorId });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "AutomationJob", targetId: jobId, before: { status: cur.status }, after: { status: to } });
    return true;
  });
  return result ? { ok: true, job: await getJob(db, ctx, jobId) } : { ok: false, reason: "invalid_state" };
}
