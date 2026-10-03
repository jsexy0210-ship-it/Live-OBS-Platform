import { randomUUID } from "node:crypto";
import type { AutomationPracticeRun, Prisma, PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS, plannerConfig } from "./config";
import { writeAudit } from "../audit/log";
import { runSteps, type EngineStats } from "./engine";
import { backoffMs, lockPlaybook } from "./queue";
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
  const startedAt = new Date();
  const t0 = performance.now();
  const stats: EngineStats = { costUsed: 0, plannerCalls: 0, playbookActions: 0, deviatedSteps: [] };
  let stepIndex = 0;
  let result: Awaited<ReturnType<typeof runSteps>>;
  const scope = { sellerId: "practice", jobId: randomUUID() };
  // 실행 전에 기록부터 남긴다(정리 대상 범위 포함). 도중에 죽으면 실패로 남고, 정리는 실행 시간 상한 뒤 정기 정리가 한다.
  const run = await db.automationPracticeRun.create({
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
  // 보관 자료는 실행마다 바로 지운다. 실패하면 기록에 남겨 정기 정리(cleanupPracticeArtifacts)가 백오프로 다시 한다.
  const cleaned = await discardScope(rt, scope);
  const outcome = result.kind === "succeeded" ? "SUCCEEDED" : result.kind === "needs_customer" ? "NEEDS_CUSTOMER" : "FAILED";
  return db.automationPracticeRun.update({
    where: { id: run.id },
    data: {
      ...(cleaned ? { cleanupPendingAt: null } : { cleanupAttempts: 1, cleanupPendingAt: new Date(Date.now() + backoffMs(1)) }),
      finishedAt: new Date(),
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
}

// 정리가 끝나지 않은 연습 실행의 보관 자료를 다시 지운다(작업자 반복에서 부른다). 실패하면 백오프로 미루고,
// 상한(10회)을 모두 실패하면 자동 정리를 멈추고 「정리 필요」(cleanupNeededAt)로 바꾼 뒤 같은 트랜잭션에서 마스터 관리자 알림 1건을 남긴다.
export async function cleanupPracticeArtifacts(db: PrismaClient, rt: Pick<AutomationRuntime, "browser" | "obs">, limit = 20): Promise<number> {
  const due = await db.automationPracticeRun.findMany({
    where: { cleanupPendingAt: { lte: new Date() }, cleanupScopeId: { not: null }, cleanupAttempts: { lt: CLEANUP_MAX_ATTEMPTS } },
    orderBy: { cleanupPendingAt: "asc" },
    take: limit,
  });
  let cleaned = 0;
  for (const r of due) {
    const ok = await discardScope(rt, { sellerId: "practice", jobId: r.cleanupScopeId! });
    const attempts = r.cleanupAttempts + 1;
    if (ok || attempts < CLEANUP_MAX_ATTEMPTS) {
      await db.automationPracticeRun.update({
        where: { id: r.id },
        data: ok ? { cleanupPendingAt: null, cleanupAttempts: attempts } : { cleanupAttempts: attempts, cleanupPendingAt: new Date(Date.now() + backoffMs(attempts)) },
      });
      if (ok) cleaned++;
      continue;
    }
    await db.$transaction(async (tx) => {
      const moved = await tx.automationPracticeRun.updateMany({
        where: { id: r.id, cleanupNeededAt: null },
        data: { cleanupAttempts: attempts, cleanupPendingAt: null, cleanupNeededAt: new Date() },
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
  const runningSince = new Date(Date.now() - AUTOMATION_LIMITS.maxRunMs);
  const runs = (await db.automationPracticeRun.findMany({ where, orderBy: { finishedAt: "desc" }, take: 100 })).filter(
    (r) => !(r.reason === PRACTICE_INCOMPLETE && r.startedAt > runningSince),
  );
  // 고객 작업에서 화면이 작업서와 달랐던 가장 최근 시각. 그 전의 연습 성공은 바뀐 화면을 검증하지 못했으므로 세지 않는다.
  const drifted = await db.automationJob.findFirst({
    where: { ...where, lastDeviationAt: { not: null } },
    orderBy: { lastDeviationAt: "desc" },
    select: { lastDeviationAt: true },
  });
  const driftAt = drifted?.lastDeviationAt ?? null;
  let streak = 0;
  for (const r of runs) {
    // 화면 이탈 전에 시작한 연습은 바뀐 화면을 검증하지 못했다(이탈 뒤에 끝났어도 세지 않는다)
    if (driftAt && r.startedAt <= driftAt) break;
    if (r.outcome !== "SUCCEEDED" || r.deviatedSteps.length > 0) break;
    streak++;
  }
  const last = runs[0]?.finishedAt;
  // 마지막 연습 뒤에 이탈이 있었다(또는 이탈 뒤 연습이 아직 기준 횟수에 못 미침) → 다시 연습해 검증
  const needsReverify = !!driftAt && (!last || driftAt >= last || streak < required);
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
