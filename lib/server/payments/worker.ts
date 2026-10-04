import type { PrismaClient } from "@prisma/client";
import { paymentGateway } from "./registry";
import { processPendingPayments, runPaymentCancelsForOrder } from "./service";

// 결제 후속 처리(커밋 뒤 PG 호출). 앱 안 정기 실행(jobs/scheduler.ts)은 트랜잭션 안에서 돌아 외부 호출에 맞지 않아 따로 둔다.
// - 5분마다 남은 취소 요청(환불·주문 취소 보상)과 승인 중(APPROVING) 결제를 PG 조회로 확정한다.
// - 여러 인스턴스가 함께 돌아도 취소 요청은 lastTriedAt 조건으로 한 곳만 잡고, 승인 확정은 조건 갱신이라 결과가 같다.
// - SCHEDULER_DISABLED=1이면 시작하지 않는다(테스트·로컬). 나이스페이 키가 없으면 매번 아무것도 하지 않는다.
export const PAYMENT_WORKER_INTERVAL_MS = 5 * 60_000;

const state = globalThis as unknown as { liveObsPaymentWorker?: ReturnType<typeof setInterval> };

export async function runPaymentWorkerOnce(db: PrismaClient, now = new Date()) {
  const gw = paymentGateway();
  if (!gw) return null;
  return processPendingPayments(db, gw, now);
}

export function startPaymentWorker(db: PrismaClient, intervalMs = PAYMENT_WORKER_INTERVAL_MS): boolean {
  if (process.env.SCHEDULER_DISABLED === "1" || state.liveObsPaymentWorker) return false;
  const tick = () => {
    runPaymentWorkerOnce(db)
      .then((r) => r && r.failed > 0 && console.error(`[payments] worker: ${r.failed} failed`))
      .catch((e) => console.error(`[payments] worker failed: ${e instanceof Error ? e.message : "error"}`));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  state.liveObsPaymentWorker = timer;
  return true;
}

// 환불 라우트용: 응답을 막지 않고 그 주문의 취소 요청을 바로 보낸다(실패해도 환불 결과는 그대로, 정기 처리가 다시 한다).
export function kickPaymentCancels(db: PrismaClient, orderId: string): Promise<void> {
  const gw = paymentGateway();
  if (!gw) return Promise.resolve();
  return runPaymentCancelsForOrder(db, gw, orderId).then(
    () => undefined,
    (e) => console.error(`[payments] refund cancel failed: ${e instanceof Error ? e.message : "error"}`),
  );
}
