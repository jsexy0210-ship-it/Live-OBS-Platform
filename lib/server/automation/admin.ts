import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { dbNow, lockJob, lockSellerAutomation, markRefundPending, writeJobEvent } from "./queue";

// 마스터 관리자(운영 역할 이상)가 사람이 정리를 마친 「정리 필요」 작업을 닫는다: CLEANUP_NEEDED → FAILED.
// 결제는 다른 실패와 같은 환불 처리 대기(REFUND_PENDING)로 넘긴다(실제 PG 환불 실행은 하지 않음 — 대표님 승인 사항).
// 잠금 순서: 판매자 → 작업 행 → 결제 행(queue.ts). 정리 메모와 함께 로그 추적(감사 기록)에 남긴다.
export type CloseCleanupResult = { ok: true; refundPending: boolean } | { ok: false; reason: "not_found" | "invalid_state" | "bad_note" };

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
