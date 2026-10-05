import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { UNDO_WINDOW_MS } from "./service";

// 확정(COMMITTING)이 서버 중단으로 끝나지 못한 일괄 등록 작업 복구(정기 실행, jobs/scheduler.ts).
// - 확정을 시작한 지 STUCK_COMMIT_MS(10분)가 지난 COMMITTING만 대상이다(committingAt, 옛 기록은 createdAt). 방금 시작한 작업은 건드리지 않는다.
// - 이어서 만들지 않는다: 어디까지 만들었는지는 createdProductIds에 있지만 payload의 어느 행인지 짝지을 정보가 없어 다시 돌리면 중복 등록 위험이 있다.
// - 지금까지 만든 상품은 그대로 두고 COMMITTED로 마감한다. 되돌리기(undoUntil)는 지금 + 24시간으로 열어 이미 만든 상품을 지울 수 있게 한다.
//   failures 맨 뒤에 「일부만 등록됨」 안내(row 0)를 덧붙인다.
// - 조건부 UPDATE(status = COMMITTING)라 여러 인스턴스가 동시에 돌거나 두 번 돌려도 작업마다 한 번만 마감한다.
export const STUCK_COMMIT_MS = 10 * 60_000;
export const COMMIT_INTERRUPTED_MESSAGE = "서버가 중단되어 일부만 등록되었습니다. 등록된 상품을 확인하고, 빠진 상품은 파일을 다시 올려 등록해 주십시오";

export async function recoverStuckBulkCommits(db: PrismaClient, now: Date): Promise<number> {
  const staleBefore = new Date(now.getTime() - STUCK_COMMIT_MS);
  const undoUntil = new Date(now.getTime() + UNDO_WINDOW_MS);
  const note = JSON.stringify({ row: 0, name: "", message: COMMIT_INTERRUPTED_MESSAGE });
  const rows = await db.$queryRaw<{ id: string; sellerId: string; created: number }[]>`
    UPDATE "BulkJob"
    SET "status" = 'COMMITTED', "committedAt" = ${now}, "undoUntil" = ${undoUntil},
        "failures" = "failures" || jsonb_build_array(${note}::jsonb)
    WHERE "status" = 'COMMITTING' AND COALESCE("committingAt", "createdAt") <= ${staleBefore}
    RETURNING "id", "sellerId", jsonb_array_length("createdProductIds") AS "created"`;
  for (const r of rows) {
    await writeAudit(db, {
      actorType: "SYSTEM",
      sellerId: r.sellerId,
      action: "bulk_io.product_import_interrupted",
      targetType: "BulkJob",
      targetId: r.id,
      after: { created: Number(r.created) },
    });
  }
  return rows.length;
}
