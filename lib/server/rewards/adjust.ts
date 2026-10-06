import type { PrismaClient, RewardLedger } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 적립금 수동 조정(SA-033, MEMBER_POINTS). 회원 한 명에게 지급(+)·회수(−)하고 사유를 원장(ADJUST)에 남긴다. 실제 현금 지급은 없다(적립금 내부 처리).
// - 실제 지급이 켜져 있으면 바로 반영: 잔액 행을 잠그고(FOR UPDATE) 잔액을 바꾼 뒤 SUCCEEDED 원장을 남긴다. 회수는 잔액을 넘을 수 없다(음수 잔액 금지, DB CHECK도 막는다).
// - 꺼져 있으면 「대기」(PENDING, testMode)로만 남기고 잔액은 그대로. 켜는 순간 일괄 지급(rewardLivePayout)이 반영한다. 회수는 이때도 지금 잔액을 넘을 수 없다.
// - 실지급 스위치 변경(rewardLivePayout.ts)과 같은 잠금(shared)으로 순서를 세워, 켜는 도중에 끼어든 대기 줄이 빠지지 않게 한다.
// - requestId(선택, UUID): 같은 값으로 다시 보내면(응답을 잃은 재시도) 새로 만들지 않고 처음 결과를 돌려준다. 다른 회원·값이면 conflict.
// - 항상 ctx.sellerId 범위. 탈퇴 회원은 대상이 아니다. 로그 추적에 남긴다(사유 포함).
export const ADJUST_MAX_AMOUNT = 10_000_000;
export const ADJUST_REASON_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REWARD_ADJUST_MESSAGES = {
  invalid_reward_adjust: "지급 또는 회수, 금액(1원 이상), 사유를 확인해 주십시오",
  reward_adjust_member_not_found: "회원을 찾을 수 없습니다",
  reward_adjust_insufficient: "회수할 금액이 회원 잔액보다 많습니다",
  reward_adjust_conflict: "같은 요청 번호로 다른 내용이 이미 처리되었습니다",
} as const;
export const REWARD_ADJUST_STATUS = { invalid_reward_adjust: 400, reward_adjust_member_not_found: 404, reward_adjust_insufficient: 409, reward_adjust_conflict: 409 } as const;
export type RewardAdjustFailure = keyof typeof REWARD_ADJUST_MESSAGES;

type Entry = Pick<RewardLedger, "id" | "type" | "amount" | "status" | "reason" | "createdAt" | "processedAt">;
export type RewardAdjustResult = { ok: true; replayed: boolean; entry: Entry; balance: number; balanceAfter: number | null } | { ok: false; reason: RewardAdjustFailure };

export async function adjustRewardBalance(db: PrismaClient, ctx: TenantContext, memberId: string, raw: unknown): Promise<RewardAdjustResult> {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const fail = (reason: RewardAdjustFailure) => ({ ok: false as const, reason });
  if (!UUID_RE.test(memberId)) return fail("reward_adjust_member_not_found");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (b.direction !== "GRANT" && b.direction !== "REVOKE") return fail("invalid_reward_adjust");
  if (typeof b.amount !== "number" || !Number.isInteger(b.amount) || b.amount < 1 || b.amount > ADJUST_MAX_AMOUNT) return fail("invalid_reward_adjust");
  if (reason.length < 1 || reason.length > ADJUST_REASON_MAX || /[\p{Cc}]/u.test(reason)) return fail("invalid_reward_adjust");
  if (b.requestId !== undefined && (typeof b.requestId !== "string" || !UUID_RE.test(b.requestId))) return fail("invalid_reward_adjust");
  const amount = b.direction === "GRANT" ? b.amount : -b.amount;
  const key = `adjust:${(b.requestId as string | undefined)?.toLowerCase() ?? randomUUID()}`;
  const sellerId = ctx.sellerId;

  return db.$transaction(async (tx): Promise<RewardAdjustResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${`reward_live_payout:${sellerId}`}))`;
    const [m] = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status"::text AS "status" FROM "BuyerMember" WHERE "id" = ${memberId}::uuid AND "sellerId" = ${sellerId}::uuid AND "deletedAt" IS NULL FOR SHARE`;
    if (!m || m.status === "WITHDRAWN") return fail("reward_adjust_member_not_found");

    // 같은 회원 잔액을 만지는 줄을 한 줄로 세운다(행이 없으면 먼저 만든다)
    await tx.$executeRaw`INSERT INTO "RewardBalance" ("sellerId", "buyerMemberId", "balance", "updatedAt") VALUES (${sellerId}::uuid, ${memberId}::uuid, 0, now()) ON CONFLICT DO NOTHING`;
    const [bal] = await tx.$queryRaw<{ balance: number }[]>`
      SELECT "balance" FROM "RewardBalance" WHERE "sellerId" = ${sellerId}::uuid AND "buyerMemberId" = ${memberId}::uuid FOR UPDATE`;

    const same = await tx.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId, idempotencyKey: key } } });
    if (same) {
      if (same.buyerMemberId !== memberId || same.type !== "ADJUST" || same.amount !== amount || same.reason !== reason) return fail("reward_adjust_conflict");
      return { ok: true, replayed: true, entry: same, balance: bal.balance, balanceAfter: same.status === "SUCCEEDED" ? bal.balance : null };
    }
    if (amount < 0 && bal.balance + amount < 0) return fail("reward_adjust_insufficient");
    if (amount > 0 && bal.balance + amount > 2_000_000_000) return fail("invalid_reward_adjust");

    const policy = await tx.rewardPolicy.findUnique({ where: { sellerId }, select: { livePayoutEnabled: true } });
    const live = policy?.livePayoutEnabled === true;
    const now = await dbNow(tx);
    const entry = await tx.rewardLedger.create({
      data: { sellerId, buyerMemberId: memberId, type: "ADJUST", amount, status: live ? "SUCCEEDED" : "PENDING", testMode: !live, reason, idempotencyKey: key, createdAt: now, processedAt: live ? now : null },
    });
    let balance = bal.balance;
    if (live) {
      balance = (await tx.rewardBalance.update({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId: memberId } }, data: { balance: { increment: amount } }, select: { balance: true } })).balance;
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId,
      action: "reward.adjust",
      targetType: "BuyerMember",
      targetId: memberId,
      reason,
      after: { amount, status: entry.status, ledgerId: entry.id, balanceAfter: live ? balance : null },
    });
    return { ok: true, replayed: false, entry, balance, balanceAfter: live ? balance : null };
  });
}
