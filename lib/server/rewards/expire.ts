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

// ───────────── 소멸 30일 전 안내(PRODUCT_SCOPE 「적립금 소멸」: 알림톡, 실패하면 문자, 메일 없음) ─────────────
// 발송 연동(알림톡·문자)은 비용·외부 키가 필요해 아직 없다. 보내는 쪽은 claimRewardExpiryNotices로 보낼 회원을 먼저 잡고
// (RewardExpiryNotice PENDING), 알림톡을 보내 보고 실패하면 문자로 보낸 뒤 잡을 때 받은 값(시도 번호 포함)으로
// markRewardExpiryNoticeSent·Failed를 부른다. 주문 알림(orders/notifications.ts)과 같은 규칙이다:
// - 회원·마지막 적립 시각마다 1행이라 동시에 돌려도 한 번만 잡는다. 새로 적립하면 기준일이 바뀌어 다음 소멸 때 다시 안내한다.
// - 실패했거나 PENDING으로 오래(10분) 멈춘 기록은 시도 3번 안에서 다시 잡는다. 대상이 아니게 된 회원(새 적립·잔액 0·이미 소멸)은 잡지 않는다.
// - 공급자 멱등키로 idempotencyKey(안내 id, 다시 잡아도 같음)를 보낸다.
export const REWARD_EXPIRY_NOTICE_DAYS = 30;
const NOTICE_MAX_ATTEMPTS = 3;
const NOTICE_STALE_MS = 10 * 60_000;

export type ClaimedRewardExpiryNotice = {
  noticeId: string;
  idempotencyKey: string;
  sellerId: string;
  buyerMemberId: string;
  // 안내할 소멸 예정 금액(지금 잔액)과 소멸 예정 시각(마지막 적립 + 3년)
  amount: number;
  expiresAt: Date;
  attempts: number;
};

export async function claimRewardExpiryNotices(db: PrismaClient, opts: { now?: Date; limit?: number } = {}): Promise<ClaimedRewardExpiryNotice[]> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('reward_expiry_notice_claim'))`;
      const now = opts.now ?? (await dbNow(tx));
      const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
      const staleBefore = new Date(now.getTime() - NOTICE_STALE_MS);
      // 안내 대상: 잔액이 있고, 소멸 예정 시각이 아직 오지 않았고, 그 30일 전이 지났다
      const due = Prisma.sql`
        SELECT b."sellerId", b."buyerMemberId", b."balance", e."at" AS "lastEarnAt",
          e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) AS "expiresAt"
        FROM "RewardBalance" b CROSS JOIN LATERAL (${lastEarnSql()}) e
        WHERE b."balance" > 0 AND e."at" IS NOT NULL
          AND e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) > ${now}
          AND e."at" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int, days => ${-REWARD_EXPIRY_NOTICE_DAYS}::int) <= ${now}`;
      const fresh = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "RewardExpiryNotice" ("sellerId", "buyerMemberId", "lastEarnAt", "status", "attempts", "claimedAt")
        SELECT d."sellerId", d."buyerMemberId", d."lastEarnAt", 'PENDING', 1, ${now}
        FROM (${due}) d
        WHERE NOT EXISTS (SELECT 1 FROM "RewardExpiryNotice" n WHERE n."buyerMemberId" = d."buyerMemberId" AND n."lastEarnAt" = d."lastEarnAt")
        ORDER BY d."expiresAt" ASC LIMIT ${limit}
        ON CONFLICT ("buyerMemberId", "lastEarnAt") DO NOTHING
        RETURNING "id"`;
      const remaining = limit - fresh.length;
      const retryable = Prisma.sql`n."attempts" < ${NOTICE_MAX_ATTEMPTS}
        AND (n."status" = 'FAILED' OR (n."status" = 'PENDING' AND n."claimedAt" <= ${staleBefore}))`;
      const retried =
        remaining <= 0
          ? []
          : await tx.$queryRaw<{ id: string }[]>`
        UPDATE "RewardExpiryNotice" n
        SET "status" = 'PENDING', "attempts" = n."attempts" + 1, "claimedAt" = ${now}, "failureReason" = NULL
        WHERE ${retryable} AND n."id" IN (
          SELECT n."id" FROM "RewardExpiryNotice" n
          JOIN (${due}) d ON d."buyerMemberId" = n."buyerMemberId" AND d."lastEarnAt" = n."lastEarnAt"
          WHERE ${retryable}
          ORDER BY d."expiresAt" ASC LIMIT ${remaining})
        RETURNING n."id"`;
      const ids = [...fresh, ...retried].map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await tx.$queryRaw<(ClaimedRewardExpiryNotice & { id: string })[]>`
        SELECT n."id", n."sellerId", n."buyerMemberId", n."attempts", b."balance" AS "amount",
          n."lastEarnAt" + make_interval(years => ${REWARD_EXPIRE_YEARS}::int) AS "expiresAt"
        FROM "RewardExpiryNotice" n
        JOIN "RewardBalance" b ON b."sellerId" = n."sellerId" AND b."buyerMemberId" = n."buyerMemberId"
        WHERE n."id" = ANY(${ids}::uuid[])
        ORDER BY 6 ASC`;
      return rows.map((r) => ({
        noticeId: r.id,
        idempotencyKey: r.id,
        sellerId: r.sellerId,
        buyerMemberId: r.buyerMemberId,
        amount: r.amount,
        expiresAt: r.expiresAt,
        attempts: r.attempts,
      }));
    },
    { timeout: 30_000 },
  );
}

type NoticeClaim = Pick<ClaimedRewardExpiryNotice, "noticeId" | "attempts">;

// 보냈음(알림톡 또는 대신 보낸 문자). 잡혀 있던 같은 시도만 바꾼다. 바꿨으면 true.
export async function markRewardExpiryNoticeSent(db: PrismaClient, claim: NoticeClaim, now?: Date): Promise<boolean> {
  const at = now ?? (await dbNow(db));
  const r = await db.rewardExpiryNotice.updateMany({ where: { id: claim.noticeId, status: "PENDING", attempts: claim.attempts }, data: { status: "SENT", sentAt: at } });
  return r.count === 1;
}

// 알림톡·문자 모두 보내지 못함. 사유는 200자까지(비밀값·개인정보를 넣지 않는다). 바꿨으면 true.
export async function markRewardExpiryNoticeFailed(db: PrismaClient, claim: NoticeClaim, reason: string): Promise<boolean> {
  const r = await db.rewardExpiryNotice.updateMany({
    where: { id: claim.noticeId, status: "PENDING", attempts: claim.attempts },
    data: { status: "FAILED", failureReason: reason.slice(0, 200) },
  });
  return r.count === 1;
}
