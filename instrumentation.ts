// 서버 시작 때 한 번 불린다(Next.js instrumentation). nodejs 런타임에서만 앱 안 정기 실행을 시작한다(lib/server/jobs/scheduler.ts).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ startScheduler }, { prisma }] = await Promise.all([import("./lib/server/jobs/scheduler"), import("./lib/server/db")]);
  startScheduler(prisma);
}
