import { randomUUID } from "node:crypto";
import type { AutomationPracticeRun, Prisma, PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS, plannerConfig } from "./config";
import { writeAudit } from "../audit/log";
import { callPort, runSteps, trackedWindow, type EngineStats } from "./engine";
import { FencingError, QUIESCE_MS, backoffMs, dbNow, lockPlaybook, quiescent, quiescentSql } from "./queue";
import type { Playbook } from "./playbook";
import { PLAYBOOKS } from "./playbooks";
import { PRACTICE_SELLER_ID, type AutomationRuntime, type JobScope, type PracticeRuntime } from "./ports";
import { STEPS } from "./steps";

// 연습 모드(확정 ⑦-1): 시험용 쇼핑몰에서 작업서를 처음부터 끝까지 실행하고 성공 여부·소요 시간·판단 호출 수·비용·화면 이탈을 남긴다.
// 고객 작업과 같은 엔진(engine.ts)을 쓰되 판매자·결제·lease 없이 돈다. 실행기(rt)는 시험용 쇼핑몰·시험용 PC에 연결된 것을 넘긴다.
// 실제 시험용 쇼핑몰 연습·실제 판단 모델 호출은 비용·외부 계정이 필요해 승인 뒤에 한다(1차는 가짜 실행기로만).

// 지원 목록 기준: 같은 작업서 버전의 최근 연습이 연속 이만큼 성공(화면 이탈 없이)
export const PRACTICE_STREAK_REQUIRED = 5;
// 정리 다시 시도 상한. 모두 실패하면 「정리 필요」로 바꾸고 마스터 관리자 알림(운영 이벤트)을 남긴다.
export const CLEANUP_MAX_ATTEMPTS = 10;
// 정리 점유 시간: 이 시간 안에 끝나지 않으면(작업자 중단) 다른 작업자가 다시 집는다
const CLEANUP_CLAIM_MS = 10 * 60_000;
// 연습 시작 때 남기는 기록의 사유(결과가 나오면 바뀐다)
const PRACTICE_INCOMPLETE = "practice_incomplete";
// 진행 중에 화면 이탈을 본 연습(결과가 나오기 전이라도 진행 중 기록에서 빠져 연속 성공을 끊는다)
const PRACTICE_DEVIATED = "practice_deviated";
// 결과가 아직 기록되지 않은(진행 중) 연습 기록의 사유
const IN_PROGRESS = [PRACTICE_INCOMPLETE, PRACTICE_DEVIATED];
// 기한이 지나 회수됐거나 늦게 끝나 세지 않는 회차
const PRACTICE_EXPIRED = "practice_expired";

// 연습 실행 범위의 보관 자료(행동 키 기록·OBS 연결 정보)를 두 실행기에 지우라고 요청한다. 둘 다 성공해야 정리 끝이다(상한 초과·오류는 실패).
async function discardScope(rt: Pick<AutomationRuntime, "browser" | "obs">, scope: JobScope): Promise<boolean> {
  const results = await Promise.all([callPort((signal) => rt.browser.discard(scope, signal)), callPort((signal) => rt.obs.discard(scope, signal))]);
  return results.every((r) => r.ok);
}

// 연습 환경(시험용 쇼핑몰·PC)에서 다른 연습이 실행 중이다. 이 호출은 실행하지 않았다(기록도 남기지 않음).
// in_use: 기한 안의 진행 중 연습이 있다. quiescing: 회수한 옛 회차의 외부 행동이 끝났다고 볼 수 있을 때까지(격리 창) 기다린다.
export class PracticeEnvironmentBusy extends Error {
  constructor(readonly reason: "in_use" | "quiescing" = "in_use") {
    super(`practice_env_busy:${reason}`);
  }
}

export async function runPractice(
  db: PrismaClient,
  rt: PracticeRuntime,
  playbook: Playbook,
  // shopHost: 연습용 시험 쇼핑몰 호스트(비밀값은 이 호스트의 관리자 경로에서만 넣는다)
  opts: { shopHost: string; maxActionsPerStep?: number; costLimitWon?: number },
): Promise<AutomationPracticeRun> {
  const t0 = performance.now();
  const stats: EngineStats = { costUsed: 0, plannerCalls: 0, playbookActions: 0, deviatedSteps: [] };
  let stepIndex = 0;
  let result: Awaited<ReturnType<typeof runSteps>>;
  const scope = { sellerId: PRACTICE_SELLER_ID, jobId: randomUUID() };
  // 실행 전에 기록부터 남긴다(정리 대상 범위 포함). 도중에 죽으면 실패로 남고, 정리는 실행 시간 상한 뒤 정기 정리가 한다.
  // 시각은 DB 시계로만 남긴다(준비 상태 판정이 DB에 저장된 다른 시각과 비교한다). 실행 시간 측정(durationMs)만 프로세스 시계
  // 연습 환경은 한 번에 한 연습만 쓴다: 환경 단위 잠금 아래 진행 중(끝나지 않았고 실행 시간 상한 안) 연습이 있으면 시작하지 않는다.
  // 이 회차 기록이 곧 환경 점유(lease)다. 상한이 지나면 점유가 풀리고, 그 뒤 늦게 끝난 결과는 성공으로 세지 않는다(아래 최종 기록).
  const claimed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('automation_practice_env'))`;
    const startedAt = await dbNow(tx);
    const cutoff = new Date(startedAt.getTime() - AUTOMATION_LIMITS.maxRunMs);
    const busy = await tx.automationPracticeRun.count({ where: { reason: { in: IN_PROGRESS }, startedAt: { gt: cutoff } } });
    if (busy > 0) return "in_use" as const;
    // 기한이 지난 진행 중 회차는 시간 경과만으로 내버려 두지 않고 토큰을 올려 회수한다: 그 실행은 다음 행동 직전 확인에서 멈춘다.
    // 이미 시작한 행동이 남았을 수 있어 새 회차는 아래에서 기준 상태로 되돌리고 확인한 뒤 실행한다
    await tx.automationPracticeRun.updateMany({
      where: { reason: { in: IN_PROGRESS }, startedAt: { lte: cutoff } },
      data: { fencingToken: { increment: 1 }, reason: PRACTICE_EXPIRED, finishedAt: startedAt },
    });
    // 옛 회차(회수했거나 끝난)의 외부 행동이 아직 끝났다고 볼 수 없으면 환경을 내주지 않는다(격리 창, 회수는 커밋하고 거절)
    const recent = await tx.automationPracticeRun.findMany({
      where: { lastActionStartedAt: { gt: new Date(startedAt.getTime() - QUIESCE_MS) } },
      select: { lastActionStartedAt: true, lastActionEndedAt: true },
    });
    if (recent.some((r) => !quiescent(r, startedAt))) return "quiescing" as const;
    return tx.automationPracticeRun.create({
      data: {
        playbookId: playbook.id,
        playbookVersion: playbook.version,
        outcome: "FAILED",
        reason: PRACTICE_INCOMPLETE,
        durationMs: 0,
        plannerCalls: 0,
        playbookActions: 0,
        costWon: 0,
        startedAt,
        cleanupScopeId: scope.jobId,
        cleanupPendingAt: new Date(startedAt.getTime() + AUTOMATION_LIMITS.maxRunMs),
      },
    });
  });
  if (claimed === "in_use" || claimed === "quiescing") throw new PracticeEnvironmentBusy(claimed);
  const run = claimed;
  // 이 회차가 아직 환경을 점유하는지(토큰 그대로·진행 중). 실행기 행동 직전마다(touch)와 주기적으로(abort) 확인한다
  const owned = { id: run.id, fencingToken: run.fencingToken, reason: { in: IN_PROGRESS } };
  const assertOwner = async () => {
    if ((await db.automationPracticeRun.count({ where: owned })) !== 1) throw new FencingError();
  };
  // 외부 행동 격리 창(trackedWindow): 시작 기록은 점유 확인과 함께(회수됐으면 던져 행동하지 않음), 세션 닫기의 시작 기록은 점유 확인 없이,
  // 종료 확인은 점유와 무관하게 자기 시작 기록이 그대로일 때만 남긴다
  const actionWindow = trackedWindow({
    start: async () => {
      const at = await dbNow(db);
      if ((await db.automationPracticeRun.updateMany({ where: owned, data: { lastActionStartedAt: at } })).count !== 1) throw new FencingError();
      return at;
    },
    // 시작 기록은 절대 뒤로 가지 않는다(DB에서 한 문장으로). 회수돼 토큰이 올랐으면 시작만 남기고 종료 확인은 남기지 않는다(강제 상한으로만 풀림)
    release: async () => {
      const owned = await db.$queryRaw<{ at: Date }[]>`UPDATE "AutomationPracticeRun" SET "lastActionStartedAt" = GREATEST(COALESCE("lastActionStartedAt", clock_timestamp()), clock_timestamp()) WHERE id = ${run.id}::uuid AND "fencingToken" = ${run.fencingToken} RETURNING "lastActionStartedAt" AS at`;
      if (owned[0]) return { at: owned[0].at, owned: true };
      const rows = await db.$queryRaw<{ at: Date }[]>`UPDATE "AutomationPracticeRun" SET "lastActionStartedAt" = GREATEST(COALESCE("lastActionStartedAt", clock_timestamp()), clock_timestamp()) WHERE id = ${run.id}::uuid RETURNING "lastActionStartedAt" AS at`;
      return { at: rows[0]?.at ?? (await dbNow(db)), owned: false };
    },
    end: async (startedAt) =>
      void (await db.automationPracticeRun.updateMany({ where: { id: run.id, lastActionStartedAt: startedAt }, data: { lastActionEndedAt: await dbNow(db) } })),
  });
  const lost = new AbortController();
  const beat = setInterval(() => void assertOwner().catch(() => lost.abort()), Math.max(20, Math.floor(AUTOMATION_LIMITS.leaseMs / 3)));
  // 매 회차 시험용 쇼핑몰·PC를 기준 상태로 되돌리고 실제 상태로 확인한다. 되돌리기·확인이 실패하면 실행하지 않고 실패로 남긴다
  // (이전 회차가 남긴 앱·웹훅·소스 위에서 성공해도 작업서를 검증한 것이 아니므로 세지 않고, 실패 기록이 연속 성공을 끊는다)
  // 되돌리기도 외부 행동이라 격리 창 기록 안에서 한다(늦게 끝나도 다음 연습은 종료 확인 또는 창 경과 뒤에만 시작)
  // 상한(T_action)을 넘기면 중단 신호를 보내고 실패로 본다(종료 확인 없음 → 격리 창은 마지막 시작 시각 + 상한 + 여유로 풀린다)
  const baseline = await callPort(
    async (signal) => {
      await rt.practice.reset(signal);
      return rt.practice.isBaseline(signal);
    },
    { window: actionWindow },
  ).catch((): { ok: false } => ({ ok: false }));
  if (!baseline.ok || !baseline.value) result = { kind: "failed", reason: "practice_reset_failed" };
  else {
    try {
      result = await runSteps(
        rt,
        scope,
        {
          startIndex: 0,
          verifying: false,
          stats,
          costLimit: opts.costLimitWon ?? plannerConfig().costLimitWon,
          maxActionsPerStep: opts.maxActionsPerStep ?? AUTOMATION_LIMITS.maxActionsPerStep,
          playbook,
          shopHost: opts.shopHost,
          // 연습은 고객 대기로 멈추면 그대로 끝낸다(보관하지 않음)
          keepBrowserStateOnWait: false,
          // 회수되면(토큰이 오르면) 다음 외부 행동 전에 멈춘다
          signal: lost.signal,
        },
        {
          // 화면 이탈은 보는 즉시(판단 모델 호출 전) 작업서 배타 잠금 아래 이 연습 기록에 남긴다: 진행 중 기록에서 빠져 연속 성공을 끊으므로
          // 연습이 끝날 때까지 이전 연속 성공으로 구매가 열려 있지 않다(고객 작업의 이탈 기록과 같은 방식)
          touch: async (s) => {
            // 행동 직전마다 점유 확인: 회수된 회차는 외부 변경 없이 멈춘다
            await assertOwner();
            if (!s.deviatedNow) return;
            await db.$transaction(async (tx) => {
              await lockPlaybook(tx, playbook.id, "exclusive");
              // 아직 진행 중인 이 회차일 때만(기한이 지나 이미 마감됐으면 되살리지 않는다)
              await tx.automationPracticeRun.updateMany({ where: owned, data: { reason: PRACTICE_DEVIATED, deviatedSteps: s.deviatedSteps } });
            });
          },
          enterVerify: async () => {},
          ...actionWindow,
          stepDone: async (next) => void (stepIndex = next),
        },
      );
    } catch {
      result = { kind: "failed", reason: "practice_error" };
    }
  }
  clearInterval(beat);
  const outcome = result.kind === "succeeded" ? "SUCCEEDED" : result.kind === "needs_customer" ? "NEEDS_CUSTOMER" : "FAILED";
  // 결과(실패·이탈 포함)부터 작업서 배타 잠금 아래 기록한다: 구매·작업 확정은 공유 잠금으로 준비 상태를 다시 읽으므로,
  // 보관 자료 정리(외부 호출)를 기다리는 동안 이전 연속 성공을 근거로 결제·작업이 확정되지 않는다.
  // 기록과 함께 정리 대기 시각을 점유 시간만큼 미뤄 둬 정기 정리가 이 실행의 정리와 겹치지 않게 한다.
  // 결과는 이 회차가 아직 환경을 점유할 때만 그대로 기록한다: 실행 시간 상한 안이고, 끝나지 않았고, 정기 정리가 가져가지 않았을 때(조건부 갱신).
  // 아니면 결과를 성공으로 세지 않고 실패(practice_expired)로 남기며, 보관 자료 정리는 정기 정리에 맡긴다.
  const recorded = await db.$transaction(async (tx) => {
    await lockPlaybook(tx, playbook.id, "exclusive");
    const now = await dbNow(tx);
    const measured = {
      durationMs: Math.round(performance.now() - t0),
      plannerCalls: stats.plannerCalls,
      playbookActions: stats.playbookActions,
      costWon: stats.costUsed,
      deviatedSteps: stats.deviatedSteps,
    };
    const own = await tx.automationPracticeRun.updateMany({
      // DB에 저장된 시작 시각 기준 실행 시간 상한 안일 때만
      where: { ...owned, startedAt: { gt: new Date(now.getTime() - AUTOMATION_LIMITS.maxRunMs) }, cleanupPendingAt: run.cleanupPendingAt, cleanupAttempts: run.cleanupAttempts },
      data: {
        cleanupPendingAt: new Date(now.getTime() + CLEANUP_CLAIM_MS),
        finishedAt: now,
        outcome,
        failedStep: outcome === "SUCCEEDED" ? null : (STEPS[stepIndex]?.key ?? null),
        reason: result.kind === "succeeded" ? null : result.kind === "needs_customer" ? result.action : result.reason.slice(0, 200),
        ...measured,
      },
    });
    if (own.count === 1) return tx.automationPracticeRun.findUniqueOrThrow({ where: { id: run.id } });
    await tx.automationPracticeRun.updateMany({ where: owned, data: { finishedAt: now, outcome: "FAILED", reason: PRACTICE_EXPIRED, ...measured } });
    return null;
  });
  if (!recorded) return db.automationPracticeRun.findUniqueOrThrow({ where: { id: run.id } });
  // 보관 자료는 결과를 기록한 뒤 지운다. 실패하면 정기 정리(cleanupPracticeArtifacts)가 백오프로 다시 한다.
  // 반영은 기록 때 점유한 상태 그대로일 때만(정기 정리가 먼저 가져갔으면 덮어쓰지 않음)
  const cleaned = await discardScope(rt, scope);
  const afterCleanup = await dbNow(db);
  await db.automationPracticeRun.updateMany({
    where: { id: run.id, cleanupAttempts: recorded.cleanupAttempts, cleanupPendingAt: recorded.cleanupPendingAt },
    data: cleaned ? { cleanupPendingAt: null } : { cleanupAttempts: recorded.cleanupAttempts + 1, cleanupPendingAt: new Date(afterCleanup.getTime() + backoffMs(1)) },
  });
  return db.automationPracticeRun.findUniqueOrThrow({ where: { id: run.id } });
}

// 정리가 끝나지 않은 연습 실행의 보관 자료를 다시 지운다(작업자 반복에서 부른다). 실패하면 백오프로 미루고,
// 상한(10회)을 모두 실패하면 자동 정리를 멈추고 「정리 필요」(cleanupNeededAt)로 바꾼 뒤 같은 트랜잭션에서 마스터 관리자 알림 1건을 남긴다.
export async function cleanupPracticeArtifacts(db: PrismaClient, rt: Pick<AutomationRuntime, "browser" | "obs">, limit = 20): Promise<number> {
  // 정리 대기 행을 원자적으로 점유한다: 고르면서 다음 대기 시각을 점유 시간만큼 미뤄 다른 작업자가 같은 행을 집지 않게 한다.
  // 결과는 고른 시점의 대기 시각·시도 횟수가 그대로일 때만 반영한다(점유가 풀린 뒤 다른 작업자가 먼저 반영했으면 덮어쓰지 않음)
  const claimed = await db.$queryRaw<{ id: string; cleanupScopeId: string; cleanupAttempts: number; cleanupPendingAt: Date; playbookId: string; playbookVersion: number }[]>`
    UPDATE "AutomationPracticeRun" SET "cleanupPendingAt" = clock_timestamp() + ${`${CLEANUP_CLAIM_MS} milliseconds`}::interval
    WHERE id IN (
      SELECT id FROM "AutomationPracticeRun"
      WHERE "cleanupPendingAt" <= clock_timestamp() AND "cleanupScopeId" IS NOT NULL AND "cleanupAttempts" < ${CLEANUP_MAX_ATTEMPTS}
        AND ${quiescentSql('"AutomationPracticeRun"')}
      ORDER BY "cleanupPendingAt" ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "cleanupScopeId", "cleanupAttempts", "cleanupPendingAt", "playbookId", "playbookVersion"`;
  let cleaned = 0;
  for (const r of claimed) {
    const ok = await discardScope(rt, { sellerId: "practice", jobId: r.cleanupScopeId });
    const attempts = r.cleanupAttempts + 1;
    const now = await dbNow(db);
    const mine = { id: r.id, cleanupAttempts: r.cleanupAttempts, cleanupPendingAt: r.cleanupPendingAt };
    if (ok || attempts < CLEANUP_MAX_ATTEMPTS) {
      const w = await db.automationPracticeRun.updateMany({
        where: mine,
        data: ok ? { cleanupPendingAt: null, cleanupAttempts: attempts } : { cleanupAttempts: attempts, cleanupPendingAt: new Date(now.getTime() + backoffMs(attempts)) },
      });
      if (ok && w.count === 1) cleaned++;
      continue;
    }
    await db.$transaction(async (tx) => {
      const moved = await tx.automationPracticeRun.updateMany({
        where: { ...mine, cleanupNeededAt: null },
        data: { cleanupAttempts: attempts, cleanupPendingAt: null, cleanupNeededAt: now },
      });
      if (moved.count === 1) {
        await writeAudit(tx, {
          actorType: "SYSTEM",
          action: "automation.practice_cleanup_needed",
          targetType: "AutomationPracticeRun",
          targetId: r.id,
          after: { playbookId: r.playbookId, playbookVersion: r.playbookVersion, attempts },
        });
      }
    });
  }
  return cleaned;
}

export type Readiness = {
  playbookId: string;
  version: number;
  streak: number;
  required: number;
  // 지원 목록에 올릴 수 있는가: 연속 성공 기준 통과 + 그 뒤 고객 작업에서 화면 이탈 없음
  verified: boolean;
  // 고객 작업에서 화면이 작업서와 달랐고(관리 화면 변경 의심) 그 뒤 연속 성공이 기준에 못 미침 → 다시 연습해 검증
  needsReverify: boolean;
  runs: number;
  successRate: number | null;
  avgDurationMs: number | null;
  avgPlannerCalls: number | null;
  avgCostWon: number | null;
};

export async function playbookReadiness(db: PrismaClient | Prisma.TransactionClient, playbook: Playbook, required = PRACTICE_STREAK_REQUIRED): Promise<Readiness> {
  // 기준 시각(최신 화면 이탈) 읽기와 연속 성공 집계를 작업서 공유 잠금 아래 한 트랜잭션에서 한다(이미 트랜잭션 안이면 그 잠금을 쓴다)
  if ("$transaction" in db) {
    return db.$transaction(async (tx) => {
      await lockPlaybook(tx, playbook.id, "shared");
      return computeReadiness(tx, playbook, required);
    });
  }
  return computeReadiness(db, playbook, required);
}

async function computeReadiness(db: Prisma.TransactionClient, playbook: Playbook, required: number): Promise<Readiness> {
  const where = { playbookId: playbook.id, playbookVersion: playbook.version };
  // 진행 중인 연습(시작 때 남긴 기록, 아직 결과 없음)은 빼고 센다. 실행 시간 상한(6시간)을 넘겨도 끝나지 않은 기록은 죽은 것으로 보고 실패로 센다.
  const runningSince = new Date((await dbNow(db)).getTime() - AUTOMATION_LIMITS.maxRunMs);
  // 걸러내기는 DB에서 한다(가져온 뒤 거르면 진행 중 기록이 많을 때 끝난 기록이 잘려 연속 성공이 줄어든다)
  const runs = await db.automationPracticeRun.findMany({
    where: { ...where, OR: [{ reason: null }, { reason: { not: PRACTICE_INCOMPLETE } }, { startedAt: { lte: runningSince } }] },
    orderBy: { startedAt: "desc" },
    take: 100,
  });
  // 고객 작업에서 화면이 작업서와 달랐던 가장 최근 시각. 그 전의 연습 성공은 바뀐 화면을 검증하지 못했으므로 세지 않는다.
  const drifted = await db.automationJob.findFirst({
    where: { ...where, lastDeviationAt: { not: null } },
    orderBy: { lastDeviationAt: "desc" },
    select: { lastDeviationAt: true },
  });
  const driftAt = drifted?.lastDeviationAt ?? null;
  // 연속 성공은 시작 시각 순서로 센다(연습 결과는 시작 때의 화면을 검증한 것이다. 끝난 순서로 세면 늦게 끝난 앞선 연습이 뒤의 연습을 가린다).
  // 화면 이탈 전에 시작한 연습은 바뀐 화면을 검증하지 못했으므로 끊김이 아니라 제외한다(이탈 뒤에 끝났어도)
  let streak = 0;
  for (const r of runs) {
    if (driftAt && r.startedAt <= driftAt) continue;
    if (r.outcome !== "SUCCEEDED" || r.deviatedSteps.length > 0) break;
    streak++;
  }
  // 이탈 뒤에 시작한 연습의 연속 성공이 기준에 못 미치면 다시 연습해 검증
  const needsReverify = !!driftAt && streak < required;
  const avg = (f: (r: AutomationPracticeRun) => number) => (runs.length ? Math.round(runs.reduce((a, r) => a + f(r), 0) / runs.length) : null);
  return {
    playbookId: playbook.id,
    version: playbook.version,
    streak,
    required,
    verified: streak >= required,
    needsReverify,
    runs: runs.length,
    successRate: runs.length ? runs.filter((r) => r.outcome === "SUCCEEDED").length / runs.length : null,
    avgDurationMs: avg((r) => r.durationMs),
    avgPlannerCalls: avg((r) => r.plannerCalls),
    avgCostWon: avg((r) => r.costWon),
  };
}

// 지원 목록: 연습으로 검증된 작업서 id(내부용. 화면에는 플랫폼 이름을 내보내지 않는다)
export async function supportedPlaybookIds(db: PrismaClient): Promise<string[]> {
  const out: string[] = [];
  for (const p of PLAYBOOKS) if ((await playbookReadiness(db, p)).verified) out.push(p.id);
  return out;
}
