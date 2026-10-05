import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 적립금 실지급 스위치(SA-034, PRODUCT_SCOPE 「실지급은 판매자별 실행 스위치(기본 꺼짐)」). 돈이 움직이는 설정이다.
// - 변경은 대표자(OWNER)만(REWARD_LIVE_PAYOUT, 직원 권한으로 줄 수 없음). 마스터 대리 조회(읽기 전용)도 거부.
// - 켤 때는 body.confirm === true가 있어야 한다(경고 확인). 끌 때는 필요 없다.
// - 값이 그대로면(이미 켜짐·꺼짐) 아무것도 바꾸지 않고 로그도 남기지 않는다(켠 시각·변경자가 덮이지 않음).
// - 바꾸면 켠·끈 시각과 변경자를 기록하고 로그 추적에 남긴다. 판매자마다 잠금을 잡아 동시 변경을 한 줄로 세운다.
// 이 값은 이후 생기는 적립 기록(testMode)과 사용 가능 여부(quote.ts)에서 읽는다. 이미 만든 기록은 바뀌지 않는다.
export type LivePayout = { enabled: boolean; changedAt: Date | null; changedByName: string | null };

export const REWARD_LIVE_PAYOUT_MESSAGES = {
  invalid_live_payout: "켜기 또는 끄기 값을 확인해 주십시오",
  live_payout_confirm_required: "실제 적립금이 지급됩니다. 내용을 확인했다는 동의가 필요합니다",
} as const;
export const REWARD_LIVE_PAYOUT_STATUS = { invalid_live_payout: 400, live_payout_confirm_required: 400 } as const;

async function readOf(db: Pick<PrismaClient, "rewardPolicy" | "sellerUser">, sellerId: string): Promise<LivePayout> {
  const p = await db.rewardPolicy.findUnique({ where: { sellerId }, select: { livePayoutEnabled: true, livePayoutChangedAt: true, livePayoutChangedBy: true } });
  if (!p) return { enabled: false, changedAt: null, changedByName: null };
  const by = p.livePayoutChangedBy ? await db.sellerUser.findFirst({ where: { id: p.livePayoutChangedBy, sellerId }, select: { name: true } }) : null;
  return { enabled: p.livePayoutEnabled, changedAt: p.livePayoutChangedAt, changedByName: by?.name ?? null };
}

export async function readLivePayout(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  return readOf(db, ctx.sellerId);
}

// 본문: { enabled: boolean, confirm?: true }. 켤 때 confirm이 true가 아니면 live_payout_confirm_required.
export async function updateLivePayout(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "REWARD_LIVE_PAYOUT");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (typeof b.enabled !== "boolean" || (b.confirm !== undefined && typeof b.confirm !== "boolean")) return { ok: false as const, reason: "invalid_live_payout" as const };
  const enabled = b.enabled;
  if (enabled && b.confirm !== true) return { ok: false as const, reason: "live_payout_confirm_required" as const };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reward_live_payout:${ctx.sellerId}`}))`;
    const cur = await tx.rewardPolicy.findUnique({ where: { sellerId: ctx.sellerId }, select: { livePayoutEnabled: true } });
    if ((cur?.livePayoutEnabled ?? false) === enabled) return { ok: true as const, changed: false as const, livePayout: await readOf(tx, ctx.sellerId) };
    const now = new Date();
    const data = { livePayoutEnabled: enabled, livePayoutChangedAt: now, livePayoutChangedBy: ctx.actorId };
    await tx.rewardPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "reward_policy.live_payout",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: { enabled: cur?.livePayoutEnabled ?? false },
      after: { enabled },
    });
    return { ok: true as const, changed: true as const, livePayout: await readOf(tx, ctx.sellerId) };
  });
}
