import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { kstMinuteLabel } from "../orders/messages";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

type Db = PrismaClient | Prisma.TransactionClient;

// 재가입 제한(대표님 결정 2026-10-03, PRODUCT_SCOPE 「구매자 탈퇴·재가입」). 판매자 설정, 기본 꺼짐.
// 켜진 쇼핑몰에서 탈퇴하면 그 회원의 CI 해시 하나만 「재가입 제한」 목적으로 제한 기간 동안 남기고(BuyerRejoinBlock),
// 기간이 끝나면 지운다. 꺼진 쇼핑몰은 남기지 않는다. 기간은 탈퇴할 때 값으로 정하고, 나중에 기간을 바꿔도 이미 남긴 기록은 그대로다.
// 판매자가 제한을 끄면 남긴 기록을 모두 지운다(목적이 없어짐).
export const REJOIN_DAYS_MIN = 1;
export const REJOIN_DAYS_MAX = 365;
export const DEFAULT_REJOIN_DAYS = 30;
const DAY_MS = 24 * 3600_000;

export const MEMBER_POLICY_MESSAGES = {
  invalid_member_policy: `재가입 제한 기간은 ${REJOIN_DAYS_MIN}일에서 ${REJOIN_DAYS_MAX}일 사이로 정해 주세요`,
} as const;

// 가입 거절 문구: 「탈퇴한 뒤 다시 가입할 수 있는 날이 아직 안 됐어요. 11월 2일 오후 3시부터 가입할 수 있어요」
export const rejoinRestrictedMessage = (availableAt: Date) => `탈퇴한 뒤 다시 가입할 수 있는 날이 아직 안 됐어요. ${kstMinuteLabel(availableAt)}부터 가입할 수 있어요`;

export type MemberPolicy = { rejoinRestrictionEnabled: boolean; rejoinRestrictionDays: number };

async function policyOf(db: Db, sellerId: string): Promise<MemberPolicy> {
  const p = await db.sellerMemberPolicy.findUnique({ where: { sellerId }, select: { rejoinRestrictionEnabled: true, rejoinRestrictionDays: true } });
  return p ?? { rejoinRestrictionEnabled: false, rejoinRestrictionDays: DEFAULT_REJOIN_DAYS };
}

export async function readMemberPolicy(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  return policyOf(db, ctx.sellerId);
}

// 본문: { rejoinRestrictionEnabled: boolean, rejoinRestrictionDays?: 1~365 정수(빼면 지금 값) }. MEMBER_POINTS, 감사 로그.
export async function updateMemberPolicy(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "MEMBER_POINTS");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const days = b.rejoinRestrictionDays;
  if (typeof b.rejoinRestrictionEnabled !== "boolean") return { ok: false as const, reason: "invalid_member_policy" as const };
  if (days !== undefined && (!Number.isInteger(days) || (days as number) < REJOIN_DAYS_MIN || (days as number) > REJOIN_DAYS_MAX)) {
    return { ok: false as const, reason: "invalid_member_policy" as const };
  }
  const enabled = b.rejoinRestrictionEnabled;
  return db.$transaction(async (tx) => {
    // 탈퇴(기록 만들기)와 겹쳐 끈 뒤에 기록이 남지 않게 같은 잠금을 쓴다
    await lockRejoin(tx, ctx.sellerId);
    const before = await policyOf(tx, ctx.sellerId);
    const after: MemberPolicy = { rejoinRestrictionEnabled: enabled, rejoinRestrictionDays: (days as number | undefined) ?? before.rejoinRestrictionDays };
    await tx.sellerMemberPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...after }, update: after });
    const purged = enabled ? 0 : (await tx.buyerRejoinBlock.deleteMany({ where: { sellerId: ctx.sellerId } })).count;
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "member_policy.rejoin_restriction",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before,
      after: { ...after, purgedRejoinBlocks: purged },
    });
    return { ok: true as const, policy: after };
  });
}

async function lockRejoin(tx: Prisma.TransactionClient, sellerId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_rejoin:${sellerId}`}))`;
}

// 탈퇴 트랜잭션 안에서 부른다. 제한이 켜져 있으면 CI 해시를 제한 기간 동안 남기고(다시 탈퇴했으면 기간을 새로), 아니면 남기지 않는다.
// 남겼으면 끝나는 시각, 아니면 null.
export async function recordRejoinBlock(tx: Prisma.TransactionClient, sellerId: string, ciHash: string, now: Date): Promise<Date | null> {
  if (!ciHash) return null;
  await lockRejoin(tx, sellerId);
  const p = await policyOf(tx, sellerId);
  if (!p.rejoinRestrictionEnabled) return null;
  const expiresAt = new Date(now.getTime() + p.rejoinRestrictionDays * DAY_MS);
  await tx.buyerRejoinBlock.upsert({
    where: { sellerId_ciHash: { sellerId, ciHash } },
    create: { sellerId, ciHash, expiresAt, createdAt: now },
    update: { expiresAt, createdAt: now },
  });
  return expiresAt;
}

// 가입 때 확인: 이 쇼핑몰에서 같은 사람의 제한이 아직 끝나지 않았으면 끝나는 시각, 아니면 null.
export async function rejoinBlockedUntil(db: Db, sellerId: string, ciHash: string, now: Date): Promise<Date | null> {
  const b = await db.buyerRejoinBlock.findUnique({ where: { sellerId_ciHash: { sellerId, ciHash } }, select: { expiresAt: true } });
  return b && b.expiresAt > now ? b.expiresAt : null;
}

// 기간이 끝난 제한 기록 파기(모든 쇼핑몰). 정기 실행 연결은 인프라 승인 뒤. 지운 수를 돌려준다.
export async function purgeExpiredRejoinBlocks(db: PrismaClient, now = new Date()): Promise<number> {
  return (await db.buyerRejoinBlock.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
