import type { PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";
import { markMailFailed } from "../mail/quota";
import { releaseDebit } from "./balance";

// 멈춘 예약 정리(messaging/jobs.ts 정기 작업 message.reconcile_and_release에서 돈다).
// 보내기 전에 잡아 둔 메일(MailDelivery PENDING)·차감(SellerMessageLedger DEBIT PENDING)이 프로세스 중단 등으로 끝나지 않으면
// 잔액이 잡힌 채 남는다. 오래된 것을 실패로 닫고 차감을 되돌린다(서식 3-1: 성공 확인이 없으면 차감하지 않음).
// - 메일: 15분 넘게 PENDING이면 FAILED + 차감 되돌림(markMailFailed). 공급자에는 발송 기록 id를 멱등키로 보냈으므로 늦게 다시 보내도 한 통.
// - 그 밖의 차감(문자·알림톡·본인인증 등, 메일에 묶이지 않은 것): 30분 넘게 PENDING이면 되돌린다(본인인증 확인 대기 10분보다 길게).
export const STALE_MAIL_HOLD_MS = 15 * 60_000;
export const STALE_DEBIT_HOLD_MS = 30 * 60_000;

// deadline(실제 시계 ms)을 넘기면 다음 건을 시작하지 않고 멈춘다(truncated). 남은 건은 다음 실행이 오래된 순으로 이어서 처리한다.
export async function expireStaleMessageHolds(db: PrismaClient, opts: { now?: Date; limit?: number; deadline?: number } = {}) {
  const over = () => opts.deadline !== undefined && Date.now() >= opts.deadline;
  const now = opts.now ?? (await dbNow(db));
  const take = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const mails = await db.mailDelivery.findMany({
    where: { status: "PENDING", createdAt: { lte: new Date(now.getTime() - STALE_MAIL_HOLD_MS) } },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true },
  });
  let mailsFailed = 0;
  for (const m of mails) {
    if (over()) return { mailsFailed, debitsReleased: 0, truncated: true };
    if (await markMailFailed(db, m.id)) mailsFailed++;
  }
  const debits = await db.sellerMessageLedger.findMany({
    where: { type: "DEBIT", status: "PENDING", createdAt: { lte: new Date(now.getTime() - STALE_DEBIT_HOLD_MS) }, mailDeliveries: { none: {} } },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true },
  });
  let debitsReleased = 0;
  for (const d of debits) {
    if (over()) return { mailsFailed, debitsReleased, truncated: true };
    if (await releaseDebit(db, d.id)) debitsReleased++;
  }
  return { mailsFailed, debitsReleased, truncated: false };
}
