import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { Rejected, guard } from "./call";
import { QUOTA_ALL, QUOTA_CHAT_RATIO, quotaDay, quotaLimits, type QuotaLimits } from "./quota";

// 파트너스 유튜브 설정·수집 현황·보관 채팅 삭제(SA-057, MASTER 배정 2026-10-05).
// - 채팅 수집 기본값: 기본 꺼짐. 켜 두면 새로 연결하는 방송(직접 연결·자동 찾기)이 채팅 수집 켜짐으로 시작한다. 이미 연결된 방송은 그대로.
// - 이번 달 수집 현황: 수집 건수(KST 달)와 API 사용 단위(구글 할당량 날짜인 태평양 날짜로 합산), 무료 한도 대비.
//   한도를 넘으면 수집을 멈추는 장치는 quota.ts(판매자 하루 상한·전체 95%)가 한다. 여기서는 그 상태를 그대로 보여 준다.
// - 보관 채팅 지금 삭제: 대표자만, 로그 추적(youtube.chat.purge)에 지운 건수를 남긴다.
const KST_MONTH = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" });
export const kstMonth = (now: Date) => KST_MONTH.format(now).slice(0, 7);
const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export async function chatDefaultFor(db: PrismaClient, sellerId: string): Promise<boolean> {
  return (await db.youtubeSellerSetting.findUnique({ where: { sellerId }, select: { chatDefaultEnabled: true } }))?.chatDefaultEnabled ?? false;
}

export async function youtubeSettings(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  return { chatDefaultEnabled: await chatDefaultFor(db, ctx.sellerId) };
}

export async function updateYoutubeSettings(db: PrismaClient, ctx: TenantContext, input: { chatDefaultEnabled?: unknown }) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  return guard(async () => {
    if (typeof input.chatDefaultEnabled !== "boolean") throw new Rejected("invalid_request");
    const before = await chatDefaultFor(db, ctx.sellerId);
    const value = input.chatDefaultEnabled;
    if (before !== value) {
      await db.youtubeSellerSetting.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, chatDefaultEnabled: value }, update: { chatDefaultEnabled: value } });
      await writeAudit(db, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "youtube.settings.update",
        targetType: "YoutubeSellerSetting",
        targetId: ctx.sellerId,
        before: { chatDefaultEnabled: before },
        after: { chatDefaultEnabled: value },
      });
    }
    return { chatDefaultEnabled: value };
  });
}

// 수집한 채팅 건수를 이번 달(KST)에 더한다(chat.ts가 저장한 건수만큼).
export async function addMonthlyChats(db: PrismaClient, sellerId: string, count: number, now: Date): Promise<void> {
  if (count <= 0) return;
  const month = kstMonth(now);
  await db.youtubeChatMonthly.upsert({ where: { sellerId_month: { sellerId, month } }, create: { sellerId, month, messages: count }, update: { messages: { increment: count } } });
}

export async function chatUsage(db: PrismaClient, ctx: TenantContext, now = new Date(), limits: QuotaLimits = quotaLimits()) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const month = kstMonth(now);
  const today = quotaDay(now);
  const [monthly, monthUnits, sellerToday, allToday, stored] = await Promise.all([
    db.youtubeChatMonthly.findUnique({ where: { sellerId_month: { sellerId: ctx.sellerId, month } }, select: { messages: true } }),
    db.youtubeQuotaUsage.aggregate({ where: { scope: ctx.sellerId, day: { startsWith: month } }, _sum: { units: true } }),
    db.youtubeQuotaUsage.findUnique({ where: { day_scope: { day: today, scope: ctx.sellerId } }, select: { units: true } }),
    db.youtubeQuotaUsage.findUnique({ where: { day_scope: { day: today, scope: QUOTA_ALL } }, select: { units: true } }),
    db.youtubeChatMessage.count({ where: { sellerId: ctx.sellerId } }),
  ]);
  const todayUnits = sellerToday?.units ?? 0;
  const platformRatio = (allToday?.units ?? 0) / limits.daily;
  const sellerStopped = todayUnits >= limits.perSeller;
  const platformStopped = platformRatio >= QUOTA_CHAT_RATIO;
  return {
    month,
    messages: monthly?.messages ?? 0,
    storedMessages: stored,
    units: { month: monthUnits._sum.units ?? 0, monthLimit: limits.perSeller * daysInMonth(month), today: todayUnits, todayLimit: limits.perSeller },
    // 지금 채팅 수집이 멈춰 있는지와 이유(seller_daily_limit: 이 쇼핑몰 오늘 한도, platform_limit: 플랫폼 전체 무료 한도 95%)
    collecting: !sellerStopped && !platformStopped,
    stoppedReason: sellerStopped ? "seller_daily_limit" : platformStopped ? "platform_limit" : null,
  };
}

// 보관 채팅 지금 삭제(대표자만). 이번 달 수집 건수는 그대로 둔다.
export async function purgeSellerChats(db: PrismaClient, ctx: TenantContext) {
  if (ctx.readOnly || !ctx.isOwner) throw forbidden();
  const r = await db.youtubeChatMessage.deleteMany({ where: { sellerId: ctx.sellerId } });
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "youtube.chat.purge",
    targetType: "YoutubeChatMessage",
    after: { deleted: r.count },
  });
  return { deleted: r.count };
}
