import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

type Db = PrismaClient | Prisma.TransactionClient;

// 재가입 제한(대표님 결정 2026-10-03, PRODUCT_SCOPE 「구매자 탈퇴·재가입」). 판매자 설정, 기본 꺼짐.
// 켜진 쇼핑몰에서 탈퇴하면 그 회원의 CI 해시 하나만 「재가입 제한」 목적으로 제한 기간 동안 남기고(BuyerRejoinBlock),
// 기간이 끝나면 지운다. 꺼진 쇼핑몰은 남기지 않는다. 기간은 가입 때 안내받은 기간(BuyerMember.rejoinRestrictionDaysAgreed)과
// 탈퇴 때 설정 중 짧은 쪽이다(동의하지 않은 더 긴 기간으로 보관하지 않음). 가입 때 제한이 꺼져 있었으면 적용하지 않는다.
// 나중에 기간을 바꿔도 이미 남긴 기록은 그대로다.
// 판매자가 제한을 끄면 남긴 기록을 모두 지운다(목적이 없어짐).
export const REJOIN_DAYS_MIN = 1;
export const REJOIN_DAYS_MAX = 365;
export const DEFAULT_REJOIN_DAYS = 30;
const DAY_MS = 24 * 3600_000;

export const MEMBER_POLICY_MESSAGES = {
  invalid_member_policy: `재가입 제한 기간은 ${REJOIN_DAYS_MIN}일에서 ${REJOIN_DAYS_MAX}일 사이로 정해 주세요`,
  rejoin_restriction_unavailable: "회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있어요",
} as const;
export const MEMBER_POLICY_STATUS = { invalid_member_policy: 400, rejoin_restriction_unavailable: 409 } as const;

// 재가입 제한을 켤 수 있는지(MASTER 결정 2026-10-03, Codex P1). 보관 동의를 철회하는 기능(회원 정보 화면·API)이 생기기 전에는
// 켤 수 없게 막는다(PUT으로 켜면 409 rejoin_restriction_unavailable, 화면은 스위치 비활성). 철회 기능과 함께 true로 바꾼다.
// 끄기와 이미 켜진 쇼핑몰의 동작은 그대로다. 테스트만 이 값을 켠다(tests/integration/buyerRejoin.test.ts).
export const REJOIN_RESTRICTION_CONFIG = { available: false };

// 「재가입 제한 정보 보관 동의」 문서 버전(docs/terms/PRIVACY_CONSENT_TEMPLATE.md 하단). 문구가 바뀌면 올린다.
export const REJOIN_RETENTION_CONSENT_VERSION = "2026-10-03.v1";

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
  if (b.rejoinRestrictionEnabled && !REJOIN_RESTRICTION_CONFIG.available) return { ok: false as const, reason: "rejoin_restriction_unavailable" as const };
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
export async function recordRejoinBlock(
  tx: Prisma.TransactionClient,
  sellerId: string,
  member: { ciHash: string; rejoinRestrictionDaysAgreed: number | null },
  now: Date,
): Promise<Date | null> {
  if (!member.ciHash || member.rejoinRestrictionDaysAgreed == null) return null;
  await lockRejoin(tx, sellerId);
  const p = await policyOf(tx, sellerId);
  if (!p.rejoinRestrictionEnabled) return null;
  const days = Math.min(p.rejoinRestrictionDays, member.rejoinRestrictionDaysAgreed);
  const ciHash = member.ciHash;
  const expiresAt = new Date(now.getTime() + days * DAY_MS);
  await tx.buyerRejoinBlock.upsert({
    where: { sellerId_ciHash: { sellerId, ciHash } },
    create: { sellerId, ciHash, expiresAt, createdAt: now },
    update: { expiresAt, createdAt: now },
  });
  return expiresAt;
}

// 가입 때 남길 재가입 제한 기간(일): 지금 제한이 켜져 있으면 그 기간, 아니면 null
export async function rejoinDaysToAgree(db: Db, sellerId: string): Promise<number | null> {
  const p = await policyOf(db, sellerId);
  return p.rejoinRestrictionEnabled ? p.rejoinRestrictionDays : null;
}

// 가입 때 확인: 이 쇼핑몰에서 같은 사람의 제한이 아직 끝나지 않았으면 끝나는 시각, 아니면 null.
export async function rejoinBlockedUntil(db: Db, sellerId: string, ciHash: string, now: Date): Promise<Date | null> {
  const b = await db.buyerRejoinBlock.findUnique({ where: { sellerId_ciHash: { sellerId, ciHash } }, select: { expiresAt: true } });
  return b && b.expiresAt > now ? b.expiresAt : null;
}

// 기간이 끝난 제한 기록 파기. sellerId를 주면 그 쇼핑몰만. 모든 쇼핑몰은 앱 안 정기 실행(jobs/scheduler.ts, 1시간)이 지우고,
// 가입·탈퇴 처리 때도 그 쇼핑몰의 끝난 기록을 먼저 지운다(끝난 기록은 판정에 쓰이지 않아 결과는 같다). 지운 수를 돌려준다.
export async function purgeExpiredRejoinBlocks(db: Db, now = new Date(), sellerId?: string): Promise<number> {
  return (await db.buyerRejoinBlock.deleteMany({ where: { expiresAt: { lte: now }, ...(sellerId ? { sellerId } : {}) } })).count;
}
