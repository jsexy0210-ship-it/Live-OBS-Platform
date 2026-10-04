import type { PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { paymentGateway } from "./registry";
import { processPendingPayments, runPaymentCancelsForOrder } from "./service";

// 결제 후속 처리(커밋 뒤 PG 호출).
// - 정기 실행(jobs/scheduler.ts 「payment.process_pending」)이 남은 취소 요청(환불·주문 취소 보상)과 승인 중(APPROVING) 결제를 PG 조회로 확정한다.
//   정기 실행 작업은 트랜잭션 안에서 불리므로 PG 호출(최대 30초)을 그 안에서 기다리지 않고 따로 띄운다.
//   여러 인스턴스·겹친 실행이어도 취소 요청은 lastTriedAt 조건으로 한 곳만 잡고, 승인 확정은 조건 갱신이라 결과가 같다.
// - 나이스페이 키가 없으면 아무것도 하지 않는다.
const state = globalThis as unknown as { liveObsPaymentRun?: Promise<unknown> | null };

export async function runPaymentWorkerOnce(db: PrismaClient, now = new Date()) {
  const gw = paymentGateway();
  if (!gw) return null;
  return processPendingPayments(db, gw, now);
}

// 정기 실행용: 이전 실행이 아직 돌고 있으면 건너뛰고, 아니면 띄워 두고 바로 돌아온다. 띄웠으면 1, 아니면 0.
export function kickPaymentWorker(now = new Date(), db: PrismaClient = prisma): number {
  if (state.liveObsPaymentRun || !paymentGateway()) return 0;
  state.liveObsPaymentRun = runPaymentWorkerOnce(db, now)
    .then((r) => r && r.failed > 0 && console.error(`[payments] process_pending: ${r.failed} failed`))
    .catch((e) => console.error(`[payments] process_pending failed: ${e instanceof Error ? e.message : "error"}`))
    .finally(() => {
      state.liveObsPaymentRun = null;
    });
  return 1;
}

// 환불 라우트용: 커밋 뒤 그 주문의 취소 요청을 바로 PG에 보낸다. 실패·결과 모름은 요청이 REQUESTED·FAILED로 남아
// 정기 실행이 다시 보내거나(REQUESTED) 사람이 확인한다(FAILED, 로그 추적). 여기서 난 오류로 환불 응답을 바꾸지 않는다.
export async function kickPaymentCancels(db: PrismaClient, orderId: string): Promise<void> {
  const gw = paymentGateway();
  if (!gw) return;
  try {
    await runPaymentCancelsForOrder(db, gw, orderId);
  } catch (e) {
    console.error(`[payments] refund cancel failed: ${e instanceof Error ? e.message : "error"}`);
  }
}
