import type { Prisma, PrismaClient } from "@prisma/client";
import { purgeOldRecoveryVerifications } from "../auth/accountRecovery";
import { purgeExpiredRejoinBlocks } from "../buyers/rejoin";
import { purgeOldSignupVerificationIps, purgeUnfinishedSignupVerifications } from "../buyers/signup";
import { prisma } from "../db";
import { purgeExpiredOAuthStates, purgeOldWebhookEvents, refreshDueTokens } from "../external/jobs";
import { processWebhookEvents } from "../external/process";
import { reconcileOrders } from "../external/reconcile";
import { externalProvider } from "../external/provider";
import { MESSAGE_JOB_NAME, runMessageJobs } from "../messaging/jobs";
import { purgeFunnelDaily, purgeFunnelSeen } from "../stats/funnel";
import { recoverStuckBulkCommits } from "../shop-bulk-io/recover";
import { settleAllLiveSellers } from "../rewards/settle";
import { recalcMonthlyGrades } from "../shop-member-grades/service";
import { rejectExpiredSupplements } from "../sellers/applications";
import { sendDecisionMails } from "../sellers/decisionMails";
import { closeAbandonedBroadcasts } from "../broadcast/stale";
import { sendBuyerOrderMails } from "../orders/buyerMails";
import { runDeliveryTrackingLookups } from "../orders/tracking";
import { deliveryTrackingProvider } from "../orders/trackingProvider";
import { processDueMemberMessages } from "../shop-member-messages/service";
import { collectInfraSnapshot } from "../ops/infra";
import { evaluateInfraAlerts } from "../ops/infraAlerts";
import { markInstanceRetired, purgeOldOpsEvents, purgeRetiredHeartbeats, recordHeartbeat, registerInstance } from "../ops/metrics";

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
  // 하루 횟수 기간이 지난 아이디 찾기·직원 연결 본인확인 기록 비식별(auth/accountRecovery.ts)
  { name: "identity_verification.anonymize_old_recovery", run: (tx, now) => purgeOldRecoveryVerifications(tx, now) },
  // 정상 종료하고 7일 지난 인스턴스의 heartbeat 지우기(ops/metrics.ts)
  { name: "ops_heartbeat.purge_retired", run: (tx, now) => purgeRetiredHeartbeats(tx, now) },
  // 받은 지 30일 지난 감시 사건 지우기((source, key)별 마지막 열림·닫힘은 남김, ops/metrics.ts)
  { name: "ops_event.purge_old", run: (tx, now) => purgeOldOpsEvents(tx, now) },
  // 서버 자원(디스크·메모리·CPU·DB) 스냅숏 저장, 35일 지난 것 삭제(ops/infra.ts)
  { name: "infra_snapshot.collect", run: (tx, now) => collectInfraSnapshot(tx, now) },
  // 인프라 기준 초과·한도 정지·외부 연결 만료·인증 오류를 알림 센터에 올린다(최고관리자만, ops/infraAlerts.ts)
  { name: "infra_alerts.evaluate", run: (tx, now) => evaluateInfraAlerts(tx, now) },
  // 발송 충전 대조·멈춘 예약 정리(messaging/jobs.ts). 이 작업이 최근에 성공해야 충전 기능을 켤 수 있다.
  { name: MESSAGE_JOB_NAME, run: (_tx, now) => runMessageJobs(prisma, now) },
  // 외부 쇼핑몰 연동(external/jobs.ts): 끝난 OAuth 시작 기록 삭제, 웹훅 원본 30일 삭제, 곧 만료되는 토큰 갱신(연동 키가 없으면 갱신은 건너뜀)
  { name: "external_oauth_state.purge", run: (tx, now) => purgeExpiredOAuthStates(tx, now) },
  { name: "external_webhook_event.purge_old", run: (tx, now) => purgeOldWebhookEvents(tx, now) },
  { name: "external_shop.refresh_tokens", run: (_tx, now) => refreshDueTokens(prisma, externalProvider(), now) },
  // 웹훅으로 받아 아직 처리하지 못한 외부 주문 이벤트를 주문대기·취소로 옮긴다(수신 직후 처리가 실패했거나 토큰 갱신을 기다린 것, external/process.ts)
  // 웹훅이 빠진 주문 보정: 최근 24시간 결제·취소 주문을 목록 조회로 다시 훑는다(external/reconcile.ts)
  { name: "external_shop.reconcile_orders", run: async (_tx, now) => { const r = await reconcileOrders(prisma, externalProvider(), { now }); return r.stored + r.cancelled; } },
  { name: "external_webhook_event.process", run: async (_tx, now) => (await processWebhookEvents(prisma, externalProvider(), { now })).processed },
  // 회원 등급 자동 재산정: 켠 쇼핑몰만, 쇼핑몰마다 달(KST)에 한 번(shop-member-grades)
  { name: "member_grade.recalc_monthly", run: (_tx, now) => recalcMonthlyGrades(prisma, now) },
  // 실제 지급이 켜진 쇼핑몰의 대기 적립 원장 지급 처리(rewards/settle.ts, 회원 단위 트랜잭션·멱등)
  { name: "reward.settle_pending", run: (_tx, now) => settleAllLiveSellers(prisma, now) },
  // 전환 단계 통계: 중복 제거 표 8일·일 집계 400일 지난 것 삭제(stats/funnel.ts)
  { name: "product_funnel_seen.purge_old", run: (tx, now) => purgeFunnelSeen(tx, now) },
  { name: "product_funnel_daily.purge_old", run: (tx, now) => purgeFunnelDaily(tx, now) },
  // 가입 신청 보완 기한(7일)이 지난 신청 자동 반려(sellers/applications.ts, 로그 추적 seller.supplement_expired)
  { name: "seller_application.reject_expired_supplements", run: (tx, now) => rejectExpiredSupplements(tx, now) },
  // 파트너스 가입 승인·반려 안내 메일(EM-101·102, sellers/decisionMails.ts). 공급자·플랫폼 사업자 정보가 없으면 보내지 않는다.
  { name: "seller_application.send_decision_mails", run: (_tx, now) => sendDecisionMails(prisma, now) },
  // 구매자 거래 메일(주문 접수·결제·발송·배송 완료·환불, EM-001~004, orders/buyerMails.ts). 제공량 안 무료·초과 충전금 차감·잔액 없으면 그 메일만 건너뜀.
  { name: "order_mail.send_buyer_mails", run: (_tx, now) => sendBuyerOrderMails(prisma, now) },
  // 12시간 넘게 방송 화면 신호가 없고 개봉 중이 없는 LIVE 방송을 끝낸다(broadcast/stale.ts, 감사 broadcast.auto_end). 재발급이 영구히 막히지 않게 하는 안전망.
  { name: "broadcast.close_abandoned", run: (_tx, now) => closeAbandonedBroadcasts(prisma, now) },
  // 배송 자동조회(orders/tracking.ts): 판매자가 켠 배송 중 주문만 6시간 간격으로 조회하고 건당 발송·이용 충전금을 차감한다. 조회 업체 어댑터가 없으면(deliveryTrackingProvider() null) 조회·차감 없이 0건.
  { name: "delivery_tracking.lookup", run: async (_tx, now) => { const r = await runDeliveryTrackingLookups(prisma, deliveryTrackingProvider(), { now }); return r.looked; } },
  // 회원 대상 발송: 시각이 된 예약을 기록으로 바꾼다(shop-member-messages, 실제 발송 채널은 아직 없음)
  // 일괄 상품 등록 확정이 서버 중단으로 10분 넘게 COMMITTING에 머문 작업을 마감한다(shop-bulk-io/recover.ts)
  { name: "bulk_job.recover_stuck_commit", run: (_tx, now) => recoverStuckBulkCommits(prisma, now) },
  { name: "member_message.record_due", run: (_tx, now) => processDueMemberMessages(prisma, now) },
];

export const SCHEDULER_INTERVAL_MS = 3600_000;

export type JobOutcome = { name: string; status: "done"; count: number } | { name: string; status: "skipped" } | { name: string; status: "failed"; error: string };

// 종료 중 상태: 종료 신호를 받으면 새 실행과 heartbeat 쓰기를 막고, 진행 중인 실행·등록이 끝나기를 기다린 뒤 종료 표시를 남긴다.
// registering: 진행 중인 등록(끝난 뒤 종료 요청이 와 있으면 스케줄러를 시작하지 않고 새 세대로 바로 종료 표시).
const shutdown = { requested: false, inflight: new Set<Promise<unknown>>(), registering: null as Promise<string | null> | null };

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

const state = globalThis as unknown as { liveObsScheduler?: ReturnType<typeof setInterval> | "registering" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

export const REGISTER_RETRY_MS = 5_000;

// 인스턴스 등록(세대 값, ops/metrics.ts)을 성공할 때까지 짧은 간격으로 다시 시도한다. 종료 중이면 그만둔다(null).
// 등록이 끝났을 때 종료 요청이 와 있으면(등록 중에 SIGTERM) 새 세대로 바로 종료 표시를 남기고 null(스케줄러를 시작하지 않음).
export function registerUntilDone(db: PrismaClient, retryMs = REGISTER_RETRY_MS): Promise<string | null> {
  const run = (async () => {
    while (!shutdown.requested) {
      let generation: string;
      try {
        generation = await registerInstance(db);
      } catch (e) {
        console.error(`[scheduler] register failed, retrying: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(retryMs);
        continue;
      }
      if (!shutdown.requested) return generation;
      await markInstanceRetired(db, new Date(), undefined, generation);
      return null;
    }
    return null;
  })();
  shutdown.registering = run;
  return run.finally(() => {
    if (shutdown.registering === run) shutdown.registering = null;
  });
}

// 서버 시작 때 한 번. 같은 프로세스에서 다시 불러도(개발 핫 리로드) 하나만 둔다.
// 등록이 성공한 뒤에야 정기 실행과 heartbeat를 시작한다(세대 값 없이 쓴 행은 종료 표시를 받을 수 없다).
export function startScheduler(db: PrismaClient, intervalMs = SCHEDULER_INTERVAL_MS): boolean {
  if (process.env.SCHEDULER_DISABLED === "1" || state.liveObsScheduler) return false;
  state.liveObsScheduler = "registering";
  const tick = () => {
    runScheduledJobs(db).catch((e) => console.error(`[scheduler] run failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  void registerUntilDone(db).then((generation) => {
    if (!generation) return;
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    state.liveObsScheduler = timer;
    // 시작 직후 한 번(서버가 뜨는 것을 막지 않게 조금 뒤에)
    setTimeout(tick, 30_000).unref?.();
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void retireOnSignal(db, signal));
  return true;
}

// 종료 처리: 새 실행·heartbeat 쓰기를 막고, 진행 중인 실행·등록을 최대 waitMs 기다린 뒤 이 프로세스 세대의 인스턴스에 종료 표시를 남긴다.
// 진행 중이던 등록은 끝나면서 스스로 새 세대에 종료 표시를 남긴다(registerUntilDone). 늦게 커밋되는 heartbeat는 종료 표시를 건드리지 않는다.
export async function retireInstance(db: PrismaClient, waitMs = 2000): Promise<void> {
  shutdown.requested = true;
  await Promise.race([Promise.allSettled([...shutdown.inflight, ...(shutdown.registering ? [shutdown.registering] : [])]), sleep(waitMs)]);
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
