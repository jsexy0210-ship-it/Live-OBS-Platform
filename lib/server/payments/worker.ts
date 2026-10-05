import type { PrismaClient } from "@prisma/client";
import { paymentGateway } from "./registry";
import { processPendingPayments, runPaymentCancelsForOrder } from "./service";

// 결제 후속 처리 타이머(커밋 뒤 PG 호출, 유튜브 워커와 같은 방식: 서버 프로세스 안 타이머). instrumentation.ts가 startPaymentWorker를 부른다.
// - 5분마다 남은 취소 요청(환불·주문 취소 보상)과 승인 중(APPROVING) 결제를 PG 조회로 확정한다.
// - SCHEDULER_DISABLED=1이면 시작하지 않고, 나이스페이 키가 없으면 매번 아무것도 하지 않는다.
// - 여러 인스턴스가 떠도 한 곳만 돌도록 매번 pg advisory xact lock을 잡는다(못 잡으면 이번 주기는 건너뜀). 앞 주기가 안 끝났으면 겹쳐 돌지 않는다.
//   잠금을 놓쳐도 취소 요청은 lastTriedAt 조건 갱신으로 한 곳만 PG에 보내고, 승인 확정은 조건 갱신이라 결과가 같다.
export const PAYMENT_WORKER_INTERVAL_MS = 5 * 60_000;
const LOCK_KEY = "payment_process_pending";
let running = false;

export async function runPaymentWorkerOnce(db: PrismaClient, now = new Date()) {
  const gw = paymentGateway();
  if (!gw || running) return null;
  running = true;
  try {
    return await db.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS "locked"`;
        if (!locked) return null;
        // 잠금은 이 트랜잭션이 끝날 때까지 유지된다. PG 호출·결제 반영은 db로(각자 트랜잭션) 한다.
        return processPendingPayments(db, gw, now);
      },
      { timeout: PAYMENT_WORKER_INTERVAL_MS - 5_000, maxWait: 10_000 },
    );
  } finally {
    running = false;
  }
}

export function startPaymentWorker(db: PrismaClient, env: Record<string, string | undefined> = process.env): (() => void) | null {
  if (env.SCHEDULER_DISABLED === "1") return null;
  const tick = async () => {
    try {
      const r = await runPaymentWorkerOnce(db);
      if (r && r.failed > 0) console.error(`[payments] process_pending: ${r.failed} failed`);
    } catch (e) {
      console.error(`[payments] process_pending failed: ${e instanceof Error ? e.message : "error"}`);
    }
  };
  const timer = setInterval(tick, PAYMENT_WORKER_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// 환불 라우트용: 커밋 뒤 그 주문의 취소 요청을 바로 PG에 보낸다. 실패·결과 모름은 요청이 REQUESTED·FAILED로 남아
// 타이머가 다시 보내거나(REQUESTED) 사람이 확인한다(FAILED, 로그 추적). 여기서 난 오류로 환불 응답을 바꾸지 않는다.
export async function kickPaymentCancels(db: PrismaClient, orderId: string): Promise<void> {
  const gw = paymentGateway();
  if (!gw) return;
  try {
    await runPaymentCancelsForOrder(db, gw, orderId);
  } catch (e) {
    console.error(`[payments] refund cancel failed: ${e instanceof Error ? e.message : "error"}`);
  }
}
