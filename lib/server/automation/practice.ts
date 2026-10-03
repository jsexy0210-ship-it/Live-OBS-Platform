import { randomUUID } from "node:crypto";
import type { AutomationPracticeRun, PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS, plannerConfig } from "./config";
import { runSteps, type EngineStats } from "./engine";
import type { Playbook } from "./playbook";
import { PLAYBOOKS } from "./playbooks";
import type { AutomationRuntime } from "./ports";
import { STEPS } from "./steps";

// 연습 모드(확정 ⑦-1): 시험용 쇼핑몰에서 작업서를 처음부터 끝까지 실행하고 성공 여부·소요 시간·판단 호출 수·비용·화면 이탈을 남긴다.
// 고객 작업과 같은 엔진(engine.ts)을 쓰되 판매자·결제·lease 없이 돈다. 실행기(rt)는 시험용 쇼핑몰·시험용 PC에 연결된 것을 넘긴다.
// 실제 시험용 쇼핑몰 연습·실제 판단 모델 호출은 비용·외부 계정이 필요해 승인 뒤에 한다(1차는 가짜 실행기로만).

// 지원 목록 기준: 같은 작업서 버전의 최근 연습이 연속 이만큼 성공(화면 이탈 없이)
export const PRACTICE_STREAK_REQUIRED = 5;

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
  } finally {
    // 연습 실행의 보관 자료(행동 키 기록·OBS 연결 정보)는 실행마다 바로 지운다(삭제 실패는 결과 기록을 막지 않음)
    await rt.browser.discard(scope).catch(() => undefined);
    await rt.obs.discard(scope).catch(() => undefined);
  }
  const outcome = result.kind === "succeeded" ? "SUCCEEDED" : result.kind === "needs_customer" ? "NEEDS_CUSTOMER" : "FAILED";
  return db.automationPracticeRun.create({
    data: {
      playbookId: playbook.id,
      playbookVersion: playbook.version,
      outcome,
      failedStep: outcome === "SUCCEEDED" ? null : (STEPS[stepIndex]?.key ?? null),
      reason: result.kind === "succeeded" ? null : result.kind === "needs_customer" ? result.action : result.reason.slice(0, 200),
      durationMs: Math.round(performance.now() - t0),
      plannerCalls: stats.plannerCalls,
      playbookActions: stats.playbookActions,
      costWon: stats.costUsed,
      deviatedSteps: stats.deviatedSteps,
      startedAt,
    },
  });
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

export async function playbookReadiness(db: PrismaClient, playbook: Playbook, required = PRACTICE_STREAK_REQUIRED): Promise<Readiness> {
  const where = { playbookId: playbook.id, playbookVersion: playbook.version };
  const runs = await db.automationPracticeRun.findMany({ where, orderBy: { finishedAt: "desc" }, take: 100 });
  // 고객 작업에서 화면이 작업서와 달랐던 가장 최근 시각. 그 전의 연습 성공은 바뀐 화면을 검증하지 못했으므로 세지 않는다.
  const drifted = await db.automationJob.findFirst({
    where: { ...where, lastDeviationAt: { not: null } },
    orderBy: { lastDeviationAt: "desc" },
    select: { lastDeviationAt: true },
  });
  const driftAt = drifted?.lastDeviationAt ?? null;
  let streak = 0;
  for (const r of runs) {
    if (driftAt && r.finishedAt <= driftAt) break;
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
