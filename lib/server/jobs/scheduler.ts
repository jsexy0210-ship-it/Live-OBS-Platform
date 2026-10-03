import type { Prisma, PrismaClient } from "@prisma/client";
import { purgeExpiredRejoinBlocks } from "../buyers/rejoin";
import { purgeOldSignupVerificationIps, purgeUnfinishedSignupVerifications } from "../buyers/signup";

// 앱 안 정기 실행(MASTER 결정 2026-10-03: 외부 cron 대신). instrumentation.ts register(nodejs 런타임)에서 startScheduler를 부른다.
// - 일정 간격(기본 1시간)으로 SCHEDULED_JOBS를 차례로 돈다. 작업마다 pg advisory xact lock을 시도해 여러 인스턴스 중 하나만 실행한다.
// - 작업 하나가 실패해도 다른 작업과 앱은 계속 동작한다(오류는 로그만).
// - SCHEDULER_DISABLED=1이면 시작하지 않는다(테스트·로컬).
// 정리 작업을 새로 만들면 여기에 넣는다. run은 트랜잭션 안에서 불리고 처리한 건수를 돌려준다.
export type ScheduledJob = { name: string; run: (tx: Prisma.TransactionClient, now: Date) => Promise<number> };

export const SCHEDULED_JOBS: ScheduledJob[] = [
  // 기간이 끝난 재가입 제한 기록(모든 쇼핑몰, buyers/rejoin.ts)
  { name: "buyer_rejoin_block.purge_expired", run: (tx, now) => purgeExpiredRejoinBlocks(tx, now) },
  // 가입을 끝내지 않고 유효 시간이 지난 본인확인 기록 비식별(모든 쇼핑몰, buyers/signup.ts)
  { name: "identity_verification.anonymize_unfinished_signup", run: (tx, now) => purgeUnfinishedSignupVerifications(tx, now) },
  // 3개월 지난 가입 본인확인 요청 IP 비우기
  { name: "identity_verification.purge_old_signup_ip", run: (tx, now) => purgeOldSignupVerificationIps(tx, now) },
];

export const SCHEDULER_INTERVAL_MS = 3600_000;

export type JobOutcome = { name: string; status: "done"; count: number } | { name: string; status: "skipped" } | { name: string; status: "failed"; error: string };

// 한 번 돈다. 다른 인스턴스가 같은 작업을 돌고 있으면(잠금을 못 잡으면) 건너뛴다.
export async function runScheduledJobs(db: PrismaClient, now = new Date(), jobs: ScheduledJob[] = SCHEDULED_JOBS): Promise<JobOutcome[]> {
  const out: JobOutcome[] = [];
  for (const job of jobs) {
    try {
      const r = await db.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`scheduled_job:${job.name}`})) AS "locked"`;
          if (!locked) return null;
          return job.run(tx, now);
        },
        { timeout: 60_000 },
      );
      out.push(r === null ? { name: job.name, status: "skipped" } : { name: job.name, status: "done", count: r });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[scheduler] ${job.name} failed: ${error}`);
      out.push({ name: job.name, status: "failed", error });
    }
  }
  return out;
}

const state = globalThis as unknown as { liveObsScheduler?: ReturnType<typeof setInterval> };

// 서버 시작 때 한 번. 같은 프로세스에서 다시 불러도(개발 핫 리로드) 하나만 둔다.
export function startScheduler(db: PrismaClient, intervalMs = SCHEDULER_INTERVAL_MS): boolean {
  if (process.env.SCHEDULER_DISABLED === "1" || state.liveObsScheduler) return false;
  const tick = () => {
    runScheduledJobs(db).catch((e) => console.error(`[scheduler] run failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  state.liveObsScheduler = setInterval(tick, intervalMs);
  state.liveObsScheduler.unref?.();
  // 시작 직후 한 번(서버가 뜨는 것을 막지 않게 조금 뒤에)
  setTimeout(tick, 30_000).unref?.();
  return true;
}
