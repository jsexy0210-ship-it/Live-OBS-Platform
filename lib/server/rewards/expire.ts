import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";

// 적립금 소멸(대표님 결정 2026-10-03, PRODUCT_SCOPE 「적립금 소멸」, 망고TCG 이용안내 기준): 마지막 적립일부터 3년 동안 새 적립이 없으면
// 남은 잔액을 소멸 원장(EXPIRE, 음수, SUCCEEDED)으로 남기고 0으로 만든다. 정기 실행 연결은 인프라 승인 뒤라 함수만 둔다.
// - 적립: 실지급(testMode 아님)이고 실패하지 않은(PENDING·SUCCEEDED) 양수 EARN·RANKING_BONUS·ADJUST 원장. 그중 가장 늦은 기록 시각이 마지막 적립일.
// - 적립 기록이 하나도 없는 잔액은 기준일을 알 수 없어 소멸하지 않는다.
// - 회원마다 트랜잭션에서 잔액 행을 잠그고(FOR UPDATE) 마지막 적립일·잔액을 다시 확인한다. 소멸하면 잔액이 0이 되므로 다시 돌려도
//   같은 결과다(멱등). 한 건이 실패해도 나머지는 계속한다.
export const REWARD_EXPIRE_YEARS = 3;

type Candidate = { sellerId: string; buyerMemberId: string };
type Check = { balance: number; lastEarnAt: Date | null; due: boolean };

export async function expireDormantRewards(db: PrismaClient, opts: { now?: Date; limit?: number } = {}) {
  const now = opts.now ?? (await dbNow(db));
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const candidates = await db.$queryRaw<Candidate[]>`
    SELECT b."sellerId", b."buyerMemberId" FROM "RewardBalance" b
    CROSS JOIN LATERAL (${lastEarnSql()}) e
    WHERE b."balance" > 0 AND e."at" IS NOT NULL AND e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) <= ${now}
    ORDER BY e."at" ASC, b."buyerMemberId" ASC
    LIMIT ${limit}`;
  const done: { sellerId: string; buyerMemberId: string; expiredPoints: number }[] = [];
  const failed: string[] = [];
  for (const c of candidates) {
    try {
      const r = await db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<Check[]>`
          SELECT b."balance", e."at" AS "lastEarnAt", (e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) <= ${now}) AS "due"
          FROM "RewardBalance" b CROSS JOIN LATERAL (${lastEarnSql()}) e
          WHERE b."sellerId" = ${c.sellerId}::uuid AND b."buyerMemberId" = ${c.buyerMemberId}::uuid
          FOR UPDATE OF b`;
        // 그사이 새로 적립했거나 잔액을 썼으면 건너뛴다
        if (!row || row.balance <= 0 || !row.lastEarnAt || !row.due) return 0;
        await tx.rewardLedger.create({
          data: {
            sellerId: c.sellerId,
            buyerMemberId: c.buyerMemberId,
            type: "EXPIRE",
            amount: -row.balance,
            status: "SUCCEEDED",
            testMode: false,
            idempotencyKey: `expire:dormant:${c.buyerMemberId}:${now.toISOString()}`,
            createdAt: now,
            processedAt: now,
          },
        });
        await tx.rewardBalance.update({ where: { sellerId_buyerMemberId: { sellerId: c.sellerId, buyerMemberId: c.buyerMemberId } }, data: { balance: 0 } });
        await writeAudit(tx, {
          actorType: "SYSTEM",
          sellerId: c.sellerId,
          action: "reward.expire",
          targetType: "BuyerMember",
          targetId: c.buyerMemberId,
          reason: "no_earn_3_years",
          after: { expiredPoints: row.balance, lastEarnAt: row.lastEarnAt.toISOString() },
        });
        return row.balance;
      });
      if (r > 0) done.push({ ...c, expiredPoints: r });
    } catch (e) {
      console.error(`[reward.expire_failed] ${c.buyerMemberId}`, e);
      failed.push(c.buyerMemberId);
    }
  }
  return { done, failed };
}

// 바깥 잔액 행(b)의 마지막 적립 시각
function lastEarnSql() {
  return Prisma.sql`
    SELECT max(l."createdAt") AS "at" FROM "RewardLedger" l
    WHERE l."sellerId" = b."sellerId" AND l."buyerMemberId" = b."buyerMemberId"
      AND l."type" IN ('EARN', 'RANKING_BONUS', 'ADJUST') AND l."amount" > 0
      AND l."status" IN ('PENDING', 'SUCCEEDED') AND l."testMode" = false`;
}
