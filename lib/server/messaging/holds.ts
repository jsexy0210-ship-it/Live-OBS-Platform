import type { PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";
import { markMailFailed } from "../mail/quota";
import { releaseDebit } from "./balance";

// 멈춘 예약 정리(정기 실행 연결은 인프라 승인 대기, 충전 기능을 켜기 전에 연결한다).
// 보내기 전에 잡아 둔 메일(MailDelivery PENDING)·차감(SellerMessageLedger DEBIT PENDING)이 프로세스 중단 등으로 끝나지 않으면
// 잔액이 잡힌 채 남는다. 오래된 것을 실패로 닫고 차감을 되돌린다(서식 3-1: 성공 확인이 없으면 차감하지 않음).
// - 메일: 15분 넘게 PENDING이면 FAILED + 차감 되돌림(markMailFailed). 공급자에는 발송 기록 id를 멱등키로 보냈으므로 늦게 다시 보내도 한 통.
// - 그 밖의 차감(문자·알림톡·본인인증 등, 메일에 묶이지 않은 것): 30분 넘게 PENDING이면 되돌린다(본인인증 확인 대기 10분보다 길게).
export const STALE_MAIL_HOLD_MS = 15 * 60_000;
export const STALE_DEBIT_HOLD_MS = 30 * 60_000;

export async function expireStaleMessageHolds(db: PrismaClient, opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? (await dbNow(db));
  const take = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const mails = await db.mailDelivery.findMany({
    where: { status: "PENDING", createdAt: { lte: new Date(now.getTime() - STALE_MAIL_HOLD_MS) } },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true },
  });
  let mailsFailed = 0;
  for (const m of mails) if (await markMailFailed(db, m.id)) mailsFailed++;
  const debits = await db.sellerMessageLedger.findMany({
    where: { type: "DEBIT", status: "PENDING", createdAt: { lte: new Date(now.getTime() - STALE_DEBIT_HOLD_MS) }, mailDeliveries: { none: {} } },
    orderBy: { createdAt: "asc" },
    take,
    select: { id: true },
  });
  let debitsReleased = 0;
  for (const d of debits) if (await releaseDebit(db, d.id)) debitsReleased++;
  return { mailsFailed, debitsReleased };
}
