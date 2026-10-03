import type { PrismaClient, RewardEarnTiming } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 적립금 지급 시점 설정(MEMBER_POINTS, 대표님 결정 2026-10-03). 결제 즉시(ON_PAYMENT) 또는 배송 완료 후(ON_DELIVERY, 기본).
// 바꾼 설정은 그 뒤 결제되는 주문부터. 결제 때 기록하지 않은 주문은 배송 완료 때 기록된다(orders/delivery.ts).
export const EARN_TIMINGS = ["ON_PAYMENT", "ON_DELIVERY"] as const satisfies readonly RewardEarnTiming[];
export const DEFAULT_EARN_TIMING: RewardEarnTiming = "ON_DELIVERY";

export async function readEarnTiming(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const p = await db.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { earnTiming: true } });
  return { earnTiming: p?.earnTiming ?? DEFAULT_EARN_TIMING };
}

export async function updateEarnTiming(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>).earnTiming : undefined;
  if (!EARN_TIMINGS.includes(v as RewardEarnTiming)) return { ok: false as const, reason: "invalid_reward_policy" as const };
  const earnTiming = v as RewardEarnTiming;
  return db.$transaction(async (tx) => {
    const before = await tx.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { earnTiming: true } });
    await tx.rewardPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, earnTiming }, update: { earnTiming } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "reward_policy.earn_timing",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: { earnTiming: before?.earnTiming ?? DEFAULT_EARN_TIMING },
      after: { earnTiming },
    });
    return { ok: true as const, earnTiming };
  });
}
