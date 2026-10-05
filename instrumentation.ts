// 서버 시작 때 한 번 불린다(Next.js instrumentation). nodejs 런타임에서만 앱 안 정기 실행을 시작한다(lib/server/jobs/scheduler.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ startScheduler }, { prisma }] = await Promise.all([import("./lib/server/jobs/scheduler"), import("./lib/server/db")]);
  startScheduler(prisma);
  // 유튜브 방송 상태 확인·채팅 수집(10초 주기, 키 없음·SCHEDULER_DISABLED=1이면 꺼짐, lib/server/youtube/worker.ts)
  (await import("./lib/server/youtube/worker")).startYoutubeWorker(prisma);
  // 결제 후속 처리(남은 PG 취소·승인 중 결제 확정, 5분, 키 없음·SCHEDULER_DISABLED=1이면 아무것도 안 함, lib/server/payments/worker.ts)
  (await import("./lib/server/payments/worker")).startPaymentWorker(prisma);
}
