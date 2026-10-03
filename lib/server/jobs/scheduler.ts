import type { Prisma, PrismaClient } from "@prisma/client";
import { purgeExpiredRejoinBlocks } from "../buyers/rejoin";
import { purgeOldSignupVerificationIps, purgeUnfinishedSignupVerifications } from "../buyers/signup";
import { markInstanceRetired, purgeRetiredHeartbeats, recordHeartbeat, registerInstance } from "../ops/metrics";

// 앱 안 정기 실행(MASTER 결정 2026-10-03: 외부 cron 대신). instrumentation.ts register(nodejs 런타임)에서 startScheduler를 부른다.
// - 일정 간격(기본 1시간)으로 SCHEDULED_JOBS를 차례로 돈다. 작업마다 pg advisory xact lock을 시도해 여러 인스턴스 중 하나만 실행한다.
// - 작업 하나가 실패해도 다른 작업과 앱은 계속 동작한다(오류는 로그만).
// - SCHEDULER_DISABLED=1이면 시작하지 않는다(테스트·로컬).
// - 돌 때마다 인스턴스·작업별 heartbeat(OpsHeartbeat)를 남긴다. 작업은 실행한 결과(done·skipped·failed), 루프 자체는 "scheduler.tick".
//   감시는 앱 밖 수집기가 이 표를 읽어 판단한다(앱과 같이 죽는 감시를 두지 않음, ops/metrics.ts).
// 정리 작업을 새로 만들면 여기에 넣는다. run은 트랜잭션 안에서 불리고 처리한 건수를 돌려준다.
export type ScheduledJob = { name: string; run: (tx: Prisma.TransactionClient, now: Date) => Promise<number> };

export const SCHEDULED_JOBS: ScheduledJob[] = [
  // 기간이 끝난 재가입 제한 기록(모든 쇼핑몰, buyers/rejoin.ts)
  { name: "buyer_rejoin_block.purge_expired", run: (tx, now) => purgeExpiredRejoinBlocks(tx, now) },
  // 가입을 끝내지 않고 유효 시간이 지난 본인확인 기록 비식별(모든 쇼핑몰, buyers/signup.ts)
  { name: "identity_verification.anonymize_unfinished_signup", run: (tx, now) => purgeUnfinishedSignupVerifications(tx, now) },
  // 3개월 지난 가입 본인확인 요청 IP 비우기
  { name: "identity_verification.purge_old_signup_ip", run: (tx, now) => purgeOldSignupVerificationIps(tx, now) },
  // 정상 종료하고 7일 지난 인스턴스의 heartbeat 지우기(ops/metrics.ts)
  { name: "ops_heartbeat.purge_retired", run: (tx, now) => purgeRetiredHeartbeats(tx, now) },
];

export const SCHEDULER_INTERVAL_MS = 3600_000;

export type JobOutcome = { name: string; status: "done"; count: number } | { name: string; status: "skipped" } | { name: string; status: "failed"; error: string };

// 종료 중 상태: 종료 신호를 받으면 새 실행과 heartbeat 쓰기를 막고, 진행 중인 실행이 끝나기를 기다린 뒤 종료 표시를 남긴다
// (진행 중이던 실행이 나중에 heartbeat를 써서 종료 표시를 되돌리지 않게).
const shutdown = { requested: false, inflight: new Set<Promise<unknown>>() };

// 한 번 돈다. 다른 인스턴스가 같은 작업을 돌고 있으면(잠금을 못 잡으면) 건너뛴다. 종료 중이면 돌지 않는다.
export async function runScheduledJobs(db: PrismaClient, now = new Date(), jobs: ScheduledJob[] = SCHEDULED_JOBS): Promise<JobOutcome[]> {
  if (shutdown.requested) return [];
  const run = runJobs(db, now, jobs);
  shutdown.inflight.add(run);
  try {
    return await run;
  } finally {
    shutdown.inflight.delete(run);
  }
}

async function runJobs(db: PrismaClient, now: Date, jobs: ScheduledJob[]): Promise<JobOutcome[]> {
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
  // heartbeat는 작업 결과와 따로 남긴다(heartbeat 쓰기가 실패해도 작업 결과는 그대로, 로그만)
  for (const o of out) await beat(db, o.name, o.status, now, o.status === "failed" ? o.error : undefined);
  await beat(db, "scheduler.tick", out.some((o) => o.status === "failed") ? "failed" : "done", now, out.filter((o) => o.status === "failed").map((o) => o.name).join(", ") || undefined);
  return out;
}

async function beat(db: PrismaClient, job: string, status: "done" | "skipped" | "failed", now: Date, error?: string) {
  if (shutdown.requested) return;
  try {
    await recordHeartbeat(db, job, status, now, error);
  } catch (e) {
    console.error(`[scheduler] heartbeat ${job} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const state = globalThis as unknown as { liveObsScheduler?: ReturnType<typeof setInterval> };

// 서버 시작 때 한 번. 같은 프로세스에서 다시 불러도(개발 핫 리로드) 하나만 둔다.
export function startScheduler(db: PrismaClient, intervalMs = SCHEDULER_INTERVAL_MS): boolean {
  if (process.env.SCHEDULER_DISABLED === "1" || state.liveObsScheduler) return false;
  // 같은 이름으로 다시 뜬 인스턴스면 종료 표시를 비운다(heartbeat 쓰기는 표시를 건드리지 않는다, ops/metrics.ts)
  registerInstance(db).catch((e) => console.error(`[scheduler] register failed: ${e instanceof Error ? e.message : String(e)}`));
  const tick = () => {
    runScheduledJobs(db).catch((e) => console.error(`[scheduler] run failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  state.liveObsScheduler = setInterval(tick, intervalMs);
  state.liveObsScheduler.unref?.();
  // 시작 직후 한 번(서버가 뜨는 것을 막지 않게 조금 뒤에)
  setTimeout(tick, 30_000).unref?.();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void retireOnSignal(db, signal));
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

// 종료 처리: 새 실행·heartbeat 쓰기를 막고, 진행 중인 실행을 최대 waitMs 기다린 뒤 이 인스턴스의 heartbeat에 종료 표시를 남긴다.
// 이미 시작돼 나중에 커밋되는 heartbeat 쓰기가 있어도 recordHeartbeat는 종료 표시를 건드리지 않으므로 표시는 그대로 남는다.
export async function retireInstance(db: PrismaClient, waitMs = 2000): Promise<void> {
  shutdown.requested = true;
  await Promise.race([Promise.allSettled([...shutdown.inflight]), sleep(waitMs)]);
  await Promise.race([markInstanceRetired(db, new Date()), sleep(waitMs)]);
}

// 시험에서만: 종료 상태를 처음으로 되돌린다
export function resetShutdownForTests() {
  shutdown.requested = false;
}

// 정상 종료 신호를 받으면 종료 처리(최대 약 4초, 실패해도 종료는 막지 않음).
// 다른 종료 처리기(Next.js 등)가 없으면 표시를 남긴 뒤 같은 신호를 다시 보내 기본 동작(프로세스 종료)을 따른다.
export async function retireOnSignal(db: PrismaClient, signal: NodeJS.Signals) {
  const others = process.listenerCount(signal) > 0;
  try {
    await retireInstance(db);
  } catch (e) {
    console.error(`[scheduler] retire mark failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!others) process.kill(process.pid, signal);
}
