import { randomUUID } from "node:crypto";
import type { AutomationPracticeRun, Prisma, PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS, plannerConfig } from "./config";
import { writeAudit } from "../audit/log";
import { runSteps, type EngineStats } from "./engine";
import { backoffMs, dbNow, lockPlaybook } from "./queue";
import type { Playbook } from "./playbook";
import { PLAYBOOKS } from "./playbooks";
import type { AutomationRuntime, JobScope } from "./ports";
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

// 연습 실행 범위의 보관 자료(행동 키 기록·OBS 연결 정보)를 두 실행기에 지우라고 요청한다. 둘 다 성공해야 정리 끝이다.
async function discardScope(rt: Pick<AutomationRuntime, "browser" | "obs">, scope: JobScope): Promise<boolean> {
  const results = await Promise.allSettled([rt.browser.discard(scope), rt.obs.discard(scope)]);
  return results.every((r) => r.status === "fulfilled");
}

export async function runPractice(
  db: PrismaClient,
  rt: AutomationRuntime,
  playbook: Playbook,
  // shopHost: 연습용 시험 쇼핑몰 호스트(비밀값은 이 호스트의 관리자 경로에서만 넣는다)
  opts: { shopHost: string; maxActionsPerStep?: number; costLimitWon?: number },
): Promise<AutomationPracticeRun> {
  const t0 = performance.now();
  const stats: EngineStats = { costUsed: 0, plannerCalls: 0, playbookActions: 0, deviatedSteps: [] };
  let stepIndex = 0;
  let result: Awaited<ReturnType<typeof runSteps>>;
  const scope = { sellerId: "practice", jobId: randomUUID() };
  // 실행 전에 기록부터 남긴다(정리 대상 범위 포함). 도중에 죽으면 실패로 남고, 정리는 실행 시간 상한 뒤 정기 정리가 한다.
  // 시각은 DB 시계로만 남긴다(준비 상태 판정이 DB에 저장된 다른 시각과 비교한다). 실행 시간 측정(durationMs)만 프로세스 시계
  const run = await db.$transaction(async (tx) => {
    const startedAt = await dbNow(tx);
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
      },
      { touch: async () => {}, enterVerify: async () => {}, stepDone: async (next) => void (stepIndex = next) },
    );
  } catch {
    result = { kind: "failed", reason: "practice_error" };
  }
  const outcome = result.kind === "succeeded" ? "SUCCEEDED" : result.kind === "needs_customer" ? "NEEDS_CUSTOMER" : "FAILED";
  // 결과(실패·이탈 포함)부터 작업서 배타 잠금 아래 기록한다: 구매·작업 확정은 공유 잠금으로 준비 상태를 다시 읽으므로,
  // 보관 자료 정리(외부 호출)를 기다리는 동안 이전 연속 성공을 근거로 결제·작업이 확정되지 않는다.
  // 기록과 함께 정리 대기 시각을 점유 시간만큼 미뤄 둬 정기 정리가 이 실행의 정리와 겹치지 않게 한다.
  const recorded = await db.$transaction(async (tx) => {
    await lockPlaybook(tx, playbook.id, "exclusive");
    const now = await dbNow(tx);
    return tx.automationPracticeRun.update({
      where: { id: run.id },
      data: {
        cleanupPendingAt: new Date(now.getTime() + CLEANUP_CLAIM_MS),
        finishedAt: now,
        outcome,
        failedStep: outcome === "SUCCEEDED" ? null : (STEPS[stepIndex]?.key ?? null),
        reason: result.kind === "succeeded" ? null : result.kind === "needs_customer" ? result.action : result.reason.slice(0, 200),
        durationMs: Math.round(performance.now() - t0),
        plannerCalls: stats.plannerCalls,
        playbookActions: stats.playbookActions,
        costWon: stats.costUsed,
        deviatedSteps: stats.deviatedSteps,
      },
    });
  });
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
    UPDATE "AutomationPracticeRun" SET "cleanupPendingAt" = now() + ${`${CLEANUP_CLAIM_MS} milliseconds`}::interval
    WHERE id IN (
      SELECT id FROM "AutomationPracticeRun"
      WHERE "cleanupPendingAt" <= now() AND "cleanupScopeId" IS NOT NULL AND "cleanupAttempts" < ${CLEANUP_MAX_ATTEMPTS}
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
