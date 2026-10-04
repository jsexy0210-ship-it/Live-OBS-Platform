import type { Prisma, PrismaClient } from "@prisma/client";
import { billingProvider } from "../billing/registry";
import { reconcileMessageCharges } from "./charge";
import { expireStaleMessageHolds } from "./holds";

// 발송 충전 정기 작업(jobs/scheduler.ts에 등록, 1시간마다): 응답이 끊긴 충전 대조 + 멈춘 예약(보내는 중인 메일·차감) 정리.
// 스케줄러가 작업마다 잡는 advisory 잠금 아래에서 끝까지 기다려 실행하므로 여러 인스턴스 중 하나만 돈다. 결과는 작업 heartbeat로 남고,
// 충전 기능을 켤 때(messaging/settings.ts) 이 작업이 최근에 성공했는지 본다.
export const MESSAGE_JOB_NAME = "message.reconcile_and_release";
// 충전을 켜려면 이 작업이 이 시간 안에 성공한 적이 있어야 한다(스케줄러 간격 1시간의 두 배)
export const MESSAGE_JOB_FRESH_MS = 2 * 3600_000;
const BATCH = 50;

export async function runMessageJobs(db: PrismaClient, now: Date): Promise<number> {
  const holds = await expireStaleMessageHolds(db, { now, limit: BATCH });
  let provider = null;
  try {
    provider = billingProvider();
  } catch {
    provider = null;
  }
  let settled = 0;
  if (provider) {
    const r = await reconcileMessageCharges(db, provider, { now, limit: BATCH });
    if (r.errors > 0) throw new Error(`message_charge_reconcile_errors:${r.errors}`);
    settled = r.paid + r.failed;
  } else if (await db.messageCharge.count({ where: { status: "PENDING" } })) {
    // 결제 공급자 설정 없이 확인 중인 충전이 남아 있으면 실패로 남겨 감시가 알 수 있게 한다
    throw new Error("billing_provider_missing");
  }
  return holds.mailsFailed + holds.debitsReleased + settled;
}

// 이 작업이 최근에 성공했는지(어느 인스턴스든). 충전 켜기 조건.
export async function messageJobsHealthy(db: PrismaClient | Prisma.TransactionClient, now: Date): Promise<boolean> {
  const row = await db.opsHeartbeat.findFirst({
    where: { job: MESSAGE_JOB_NAME, lastStatus: "done", lastOkAt: { gte: new Date(now.getTime() - MESSAGE_JOB_FRESH_MS) } },
    select: { job: true },
  });
  return row !== null;
}
