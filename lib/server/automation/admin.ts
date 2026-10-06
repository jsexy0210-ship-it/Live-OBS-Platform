import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { monthlyLimitWon } from "./budget";
import { publicError } from "./jobs";
import { STEPS } from "./steps";
import { STEP_DONE_REASON } from "./queue";
import { dbNow, lockJob, lockSellerAutomation, markRefundPending, quiescent, writeJobEvent } from "./queue";

// 마스터 관리자(운영 역할 이상)가 사람이 정리를 마친 「정리 필요」 작업을 닫는다: CLEANUP_NEEDED → FAILED.
// 결제는 다른 실패와 같은 환불 처리 대기(REFUND_PENDING)로 넘긴다(실제 PG 환불 실행은 하지 않음 — 대표님 승인 사항).
// 잠금 순서: 판매자 → 작업 행 → 결제 행(queue.ts). 정리 메모와 함께 로그 추적(감사 기록)에 남긴다.
export type CloseCleanupResult = { ok: true; refundPending: boolean } | { ok: false; reason: "not_found" | "invalid_state" | "bad_note" | "action_in_progress" };

export async function closeCleanupNeeded(
  db: PrismaClient,
  admin: AdminSessionContext,
  jobId: string,
  note: unknown,
  meta: { ip: string | null; userAgent: string | null },
): Promise<CloseCleanupResult> {
  if (typeof note !== "string" || !note.trim() || note.length > 500) return { ok: false, reason: "bad_note" };
  return db.$transaction(async (tx) => {
    const head = await tx.automationJob.findUnique({ where: { id: jobId }, select: { sellerId: true } });
    if (!head) return { ok: false, reason: "not_found" } as const;
    await lockSellerAutomation(tx, head.sellerId);
    await lockJob(tx, jobId);
    const cur = await tx.automationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (cur.status !== "CLEANUP_NEEDED") return { ok: false, reason: "invalid_state" } as const;
    const now = await dbNow(tx);
    // 진행 중일 수 있는 외부 행동이 끝났다고 볼 수 있을 때까지(격리 창) 닫지 않는다: 닫으면 열린 작업 제약이 풀려 새 설치가 겹칠 수 있다
    if (!quiescent(cur, now)) return { ok: false, reason: "action_in_progress" } as const;
    // 판매자가 취소해 정리 필요가 된 작업은 취소로 닫는다(시작 뒤 취소는 환불 없음, 확정 ②). 그 밖(실패)은 실패·환불 처리 대기
    const end = cur.cancelRequestedAt ? "CANCELED" : "FAILED";
    await tx.automationJob.update({ where: { id: jobId }, data: { status: end, finishedAt: now } });
    await writeJobEvent(tx, cur, "CLEANUP_NEEDED", end, cur.fencingToken, { reason: "cleanup_done" });
    const before = cur.paymentId ? await tx.automationPayment.findUnique({ where: { id: cur.paymentId }, select: { status: true } }) : null;
    if (end === "FAILED") await markRefundPending(tx, cur, "cleanup_done", now);
    const refundPending = end === "FAILED" && before?.status === "PAID";
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      sellerId: cur.sellerId,
      action: "automation.cleanup_closed",
      targetType: "AutomationJob",
      targetId: jobId,
      before: { status: "CLEANUP_NEEDED", lastError: cur.lastError },
      after: { status: end, refundPending },
      reason: note.trim(),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true, refundPending } as const;
  });
}

// ───── 마스터 관리자 조회(MA-110 목록 · MA-111 상세). 읽기 전용, 비밀값·브라우저 상태·원문 오류는 내보내지 않는다 ─────

export type AdminJobFilter = "all" | "customer" | "failed" | "done";
const FILTER_WHERE: Record<AdminJobFilter, Prisma.AutomationJobWhereInput> = {
  all: {},
  customer: { status: "NEEDS_CUSTOMER" },
  failed: { status: { in: ["FAILED", "CLEANUP_NEEDED"] } },
  done: { status: "SUCCEEDED" },
};
export const isAdminJobFilter = (v: unknown): v is AdminJobFilter => typeof v === "string" && v in FILTER_WHERE;

// KST 오늘 0시(DB 시계 기준 계산은 쿼리에서)
export async function adminJobSummary(db: PrismaClient) {
  const [running, queued, customer, done, failed, cost] = await Promise.all([
    db.automationJob.count({ where: { status: { in: ["RUNNING", "VERIFYING"] } } }),
    db.automationJob.count({ where: { status: "QUEUED" } }),
    db.automationJob.count({ where: { status: "NEEDS_CUSTOMER" } }),
    db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "AutomationJob" WHERE status = 'SUCCEEDED' AND "finishedAt" >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
    db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "AutomationJob" WHERE status IN ('FAILED','CLEANUP_NEEDED') AND "updatedAt" >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
    db.$queryRaw<{ won: bigint | null }[]>`SELECT sum("costWon") AS won FROM "ExternalApiCostLedger" WHERE "createdAt" >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
  ]);
  const usage = await db.$queryRaw<{ usedWon: number; limitWon: number; stoppedAt: Date | null }[]>`
    SELECT "usedWon", "limitWon", "stoppedAt" FROM "ExternalApiUsage" WHERE provider = 'gemini' AND period = to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM')`;
  return {
    running,
    queued,
    customerWaiting: customer,
    doneToday: Number(done[0]?.n ?? 0),
    failedToday: Number(failed[0]?.n ?? 0),
    costTodayWon: Number(cost[0]?.won ?? 0),
    monthly: { usedWon: usage[0]?.usedWon ?? 0, limitWon: usage[0]?.limitWon ?? monthlyLimitWon(), stopped: usage[0]?.stoppedAt != null },
  };
}

export async function adminJobList(db: PrismaClient, filter: AdminJobFilter) {
  const rows = await db.automationJob.findMany({
    where: FILTER_WHERE[filter],
    include: { payment: { select: { status: true, amount: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const sellers = await db.seller.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.sellerId))] } }, select: { id: true, shopName: true } });
  const names = new Map(sellers.map((s) => [s.id, s.shopName]));
  return rows.map((j) => ({
    id: j.id,
    sellerId: j.sellerId,
    shopName: names.get(j.sellerId) ?? "",
    shopHost: j.shopHost,
    kind: j.kind,
    status: j.status,
    step: STEPS[j.stepIndex]?.key ?? null,
    customerAction: j.customerAction,
    paymentStatus: j.payment?.status ?? null,
    amount: j.payment?.amount ?? 0,
    attempts: j.attempts,
    lastError: publicError(j.lastError),
    startedAt: j.startedAt,
    queuedAt: j.queuedAt,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  }));
}

export async function adminJobDetail(db: PrismaClient, jobId: string) {
  const j = await db.automationJob.findUnique({ where: { id: jobId }, include: { payment: true } });
  if (!j) return null;
  const [seller, events] = await Promise.all([
    db.seller.findUnique({ where: { id: j.sellerId }, select: { shopName: true } }),
    db.automationJobEvent.findMany({ where: { jobId }, orderBy: { createdAt: "asc" }, take: 200, select: { id: true, fromStatus: true, toStatus: true, detail: true, createdAt: true } }),
  ]);
  return {
    id: j.id,
    sellerId: j.sellerId,
    shopName: seller?.shopName ?? "",
    shopHost: j.shopHost,
    kind: j.kind,
    status: j.status,
    step: STEPS[j.stepIndex]?.key ?? null,
    stepNumber: Math.min(j.stepIndex + 1, STEPS.length),
    stepCount: STEPS.length,
    customerAction: j.customerAction,
    actionDeadlineAt: j.actionDeadlineAt,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    lastError: publicError(j.lastError),
    plannerCalls: j.plannerCalls,
    costUsed: j.costUsed,
    costLimit: j.costLimit,
    cleanupNeededAt: j.cleanupNeededAt,
    verifiedAt: j.verifiedAt,
    queuedAt: j.queuedAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    createdAt: j.createdAt,
    payment: j.payment
      ? { status: j.payment.status, amount: j.payment.amount, refundReason: j.payment.refundReason, refundRequestedAt: j.payment.refundRequestedAt, refundedAt: j.payment.refundedAt }
      : null,
    // 기록의 detail은 내부 값이 섞일 수 있어 내보내지 않고 상태 전이만 준다
    events: events.filter((e) => (e.detail as { reason?: unknown } | null)?.reason !== STEP_DONE_REASON).map((e) => ({ id: e.id, from: e.fromStatus, to: e.toStatus, at: e.createdAt })),
  };
}
