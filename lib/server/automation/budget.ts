import type { PrismaClient } from "@prisma/client";

// 외부 유료 API 월 한도(2026-10-05 대표님 결정: 자동 연결·외부 쇼핑몰 연동은 월 1만 원 이내).
// 월은 한국 시간 기준이며 DB 시계로 가른다. 한도에 닿으면 그 달은 새 호출을 하지 않는다(소프트 상한: 동시에 진행 중인 호출 몫만큼 넘을 수 있다).
// 한도 값은 환경변수로 낮출 수만 있다(1만 원을 넘기는 값·잘못된 값은 1만 원).
export const EXTERNAL_API_MONTHLY_LIMIT_WON = 10_000;
const DB_INT_MAX = 2_147_483_647;

export function monthlyLimitWon(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.EXTERNAL_API_MONTHLY_LIMIT_WON);
  return Number.isInteger(n) && n > 0 && n <= EXTERNAL_API_MONTHLY_LIMIT_WON ? n : EXTERNAL_API_MONTHLY_LIMIT_WON;
}

// 이번 달 호출을 더 해도 되는가. 사용량 행이 없으면(이번 달 첫 호출 전) 열려 있다.
export async function budgetOpen(db: PrismaClient, provider: string, limitWon: number = monthlyLimitWon()): Promise<boolean> {
  const rows = await db.$queryRaw<{ open: boolean }[]>`
    SELECT ("usedWon" < ${limitWon} AND "stoppedAt" IS NULL) AS open
    FROM "ExternalApiUsage"
    WHERE provider = ${provider} AND period = to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM')`;
  return rows[0]?.open ?? true;
}

// 호출 비용을 원장에 남기고 월 합계를 올린다(한 트랜잭션). 합계가 한도에 닿으면 정지 시각을 남긴다(그 달 동안 유지).
export async function recordExternalCost(
  db: PrismaClient,
  e: { provider: string; purpose: string; jobId?: string | null; costWon: number; limitWon?: number },
): Promise<void> {
  if (!Number.isInteger(e.costWon) || e.costWon < 0) throw new Error("bad_cost");
  const cost = Math.min(e.costWon, DB_INT_MAX);
  const limit = e.limitWon ?? monthlyLimitWon();
  await db.$transaction([
    db.$executeRaw`
      INSERT INTO "ExternalApiUsage" (provider, period, "usedWon", "limitWon", "stoppedAt", "updatedAt")
      VALUES (${e.provider}, to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM'), ${cost}, ${limit}, CASE WHEN ${cost} >= ${limit} THEN now() END, now())
      ON CONFLICT (provider, period) DO UPDATE SET
        "usedWon" = LEAST("ExternalApiUsage"."usedWon" + EXCLUDED."usedWon", ${DB_INT_MAX}),
        "limitWon" = EXCLUDED."limitWon",
        "stoppedAt" = COALESCE("ExternalApiUsage"."stoppedAt", CASE WHEN LEAST("ExternalApiUsage"."usedWon" + EXCLUDED."usedWon", ${DB_INT_MAX}) >= EXCLUDED."limitWon" THEN now() END),
        "updatedAt" = now()`,
    db.$executeRaw`
      INSERT INTO "ExternalApiCostLedger" (provider, period, purpose, "jobId", "costWon")
      VALUES (${e.provider}, to_char(now() AT TIME ZONE 'Asia/Seoul', 'YYYY-MM'), ${e.purpose}, ${e.jobId ?? null}::uuid, ${cost})`,
  ]);
}

// 엔진에 넘기는 모양(판단 호출 직전 열림 확인, 직후 비용 기록)
export type Budget = { open(): Promise<boolean>; record(costWon: number): Promise<void> };
export const PLANNER_PROVIDER = "gemini";
export const plannerBudget = (db: PrismaClient, jobId: string | null): Budget => ({
  open: () => budgetOpen(db, PLANNER_PROVIDER),
  record: (costWon) => recordExternalCost(db, { provider: PLANNER_PROVIDER, purpose: "automation.planner", jobId, costWon }),
});
