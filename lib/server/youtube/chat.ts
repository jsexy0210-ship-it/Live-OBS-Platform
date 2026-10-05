import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { Rejected, callYoutube, guard } from "./call";
import type { YoutubeClient } from "./client";
import { addMonthlyChats } from "./settings";
import { QUOTA_CHAT_RATIO, QUOTA_WARN_RATIO, quotaUsage } from "./quota";

// 유튜브 채팅 수집(MASTER 승인 2026-10-05, 무료 할당량 안에서만).
// - 기본 꺼짐. 파트너스가 방송(진행 중 연결)마다 켠 LIVE 연결만 수집한다. 켜지 않으면 할당량을 쓰지 않는다.
// - 조회 간격: max(유튜브가 준 간격, 20초). 새 메시지가 없으면 2배씩 늘려 60초까지. 할당량 80%를 넘으면 2배(최대 120초).
//   95%면 수집하지 않는다(방송 상태 감지는 계속). 판매자 하루 상한(quota.ts)을 넘으면 그 판매자만 쉰다.
// - 같은 메시지는 판매자마다 유튜브 메시지 id로 한 번만 저장(skipDuplicates, (sellerId, messageId) 유니크). 다음 페이지 토큰을 이어 받는다.
// - 저장은 표시 이름·본문 앞 200자·게시 시각·작성자 채널 id뿐, 30일 지나면 지운다(purgeOldChats).
// - 닉네임 매칭은 표시용이다. 주문을 바꾸지 않는다.
export const CHAT_MIN_INTERVAL_MS = 20_000;
export const CHAT_IDLE_MAX_MS = 60_000;
export const CHAT_SLOW_MAX_MS = 120_000;
export const CHAT_RETENTION_DAYS = 30;

// 수집을 켤 때 파트너스 화면에 보여 줄 고지(명사형·합니다체). 화면 세션은 이 문구를 그대로 쓴다.
export const CHAT_NOTICE = `채팅 수집을 켜면 시청자의 채팅 표시 이름과 채팅 본문 앞 200자를 ${CHAT_RETENTION_DAYS}일 동안 보관합니다. 주문 닉네임 확인에만 씁니다.`;

export type ChatReport = { polled: number; saved: number; stopped?: "quota_exhausted" };

export function nextChatInterval(prevMs: number | null, youtubeMs: number | null, saved: number, ratio: number): number {
  const base = Math.max(youtubeMs ?? 0, CHAT_MIN_INTERVAL_MS);
  let ms = saved > 0 ? base : Math.min(Math.max((prevMs ?? base) * 2, base), Math.max(CHAT_IDLE_MAX_MS, base));
  if (ratio >= QUOTA_WARN_RATIO) ms = Math.min(ms * 2, Math.max(CHAT_SLOW_MAX_MS, base));
  return ms;
}

export async function collectChats(db: PrismaClient, client: YoutubeClient, now = new Date()): Promise<ChatReport> {
  const report: ChatReport = { polled: 0, saved: 0 };
  let ratio = (await quotaUsage(db, now)).ratio;
  if (ratio >= QUOTA_CHAT_RATIO) return { ...report, stopped: "quota_exhausted" };
  const links = await db.youtubeLiveLink.findMany({
    where: { status: "LIVE", chatEnabled: true, liveChatId: { not: null }, OR: [{ chatNextPollAt: null }, { chatNextPollAt: { lte: now } }] },
    orderBy: [{ chatNextPollAt: { sort: "asc", nulls: "first" } }],
  });
  for (const link of links) {
    try {
      const page = await callYoutube(db, "liveChatMessages.list", "chat", link.sellerId, now, () => client.chatMessages(link.liveChatId!, link.chatPageToken));
      report.polled++;
      if (page.ended) {
        await db.youtubeLiveLink.updateMany({ where: { id: link.id, sellerId: link.sellerId }, data: { liveChatId: null, chatPageToken: null, chatNextPollAt: null } });
        continue;
      }
      const r = page.messages.length
        ? await db.youtubeChatMessage.createMany({ data: page.messages.map((m) => ({ ...m, sellerId: link.sellerId, liveLinkId: link.id })), skipDuplicates: true })
        : { count: 0 };
      report.saved += r.count;
      await addMonthlyChats(db, link.sellerId, r.count, now);
      ratio = (await quotaUsage(db, now)).ratio;
      const interval = nextChatInterval(link.chatIntervalMs, page.pollingIntervalMillis, r.count, ratio);
      await db.youtubeLiveLink.updateMany({
        where: { id: link.id, sellerId: link.sellerId, status: "LIVE" },
        data: { chatPageToken: page.nextPageToken ?? link.chatPageToken, chatIntervalMs: interval, chatNextPollAt: new Date(now.getTime() + interval) },
      });
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      if (e.reason === "quota_exhausted") return { ...report, stopped: "quota_exhausted" };
      // 판매자 몫 초과·유튜브 일시 오류는 그 방송만 1분 쉰다
      await db.youtubeLiveLink.updateMany({ where: { id: link.id, sellerId: link.sellerId }, data: { chatNextPollAt: new Date(now.getTime() + CHAT_IDLE_MAX_MS) } });
    }
  }
  return report;
}

export async function setChatEnabled(db: PrismaClient, ctx: TenantContext, enabled: unknown) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  return guard(async () => {
    if (typeof enabled !== "boolean") throw new Rejected("invalid_request");
    const link = await db.youtubeLiveLink.findFirst({ where: { sellerId: ctx.sellerId, status: { in: ["UPCOMING", "LIVE"] } }, select: { id: true, chatEnabled: true } });
    if (!link) throw new Rejected("no_active_live");
    if (link.chatEnabled !== enabled) {
      await db.youtubeLiveLink.updateMany({ where: { id: link.id, sellerId: ctx.sellerId }, data: { chatEnabled: enabled, chatNextPollAt: null, chatIntervalMs: null } });
      await writeAudit(db, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: enabled ? "youtube.chat.enable" : "youtube.chat.disable",
        targetType: "YoutubeLiveLink",
        targetId: link.id,
      });
    }
    return { chatEnabled: enabled, notice: CHAT_NOTICE };
  });
}

// 비교용 닉네임: 유니코드 정규화(NFKC), 공백 제거, 소문자, 앞 @ 제거
export const normalizeNickname = (v: string) => v.normalize("NFKC").replace(/\s+/g, "").toLowerCase().replace(/^@+/, "");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHAT_MATCH_ORDER_LIMIT = 500;

// 방송(지정 없으면 유튜브가 붙은 가장 최근 방송) 시간 안의 주문 닉네임이 그 방송 채팅에 나왔는지.
export async function chatMatches(db: PrismaClient, ctx: TenantContext, broadcastSessionId?: string | null) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  return guard(async () => {
    if (broadcastSessionId && !UUID.test(broadcastSessionId)) throw new Rejected("invalid_request");
    const link = await db.youtubeLiveLink.findFirst({
      where: { sellerId: ctx.sellerId, broadcastSessionId: broadcastSessionId ? broadcastSessionId : { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, videoId: true, chatEnabled: true, broadcast: { select: { id: true, title: true, startedAt: true, endedAt: true } } },
    });
    if (!link?.broadcast) return { broadcast: null, chatEnabled: false, summary: { orders: 0, matched: 0, chatAuthors: 0 }, orders: [] };
    const b = link.broadcast;
    const [authors, orders] = await Promise.all([
      db.youtubeChatMessage.groupBy({ by: ["authorName"], where: { sellerId: ctx.sellerId, liveLinkId: link.id }, _max: { publishedAt: true } }),
      db.order.findMany({
        where: { sellerId: ctx.sellerId, createdAt: { gte: b.startedAt, ...(b.endedAt ? { lte: b.endedAt } : {}) } },
        orderBy: { createdAt: "asc" },
        take: CHAT_MATCH_ORDER_LIMIT,
        select: { id: true, orderNo: true, status: true, broadcastNicknameSnapshot: true, createdAt: true },
      }),
    ]);
    const lastChat = new Map<string, Date>();
    for (const a of authors) {
      const key = normalizeNickname(a.authorName);
      const at = a._max.publishedAt;
      if (key && at && (!lastChat.has(key) || lastChat.get(key)! < at)) lastChat.set(key, at);
    }
    const rows = orders.map((o) => {
      const at = lastChat.get(normalizeNickname(o.broadcastNicknameSnapshot)) ?? null;
      return { orderId: o.id, orderNo: o.orderNo, status: o.status, nickname: o.broadcastNicknameSnapshot, orderedAt: o.createdAt, matched: !!at, lastChatAt: at };
    });
    return {
      broadcast: { id: b.id, title: b.title, startedAt: b.startedAt, endedAt: b.endedAt, videoId: link.videoId },
      chatEnabled: link.chatEnabled,
      summary: { orders: rows.length, matched: rows.filter((r) => r.matched).length, chatAuthors: lastChat.size },
      orders: rows,
    };
  });
}

export async function purgeOldChats(db: PrismaClient, now: Date): Promise<number> {
  const r = await db.youtubeChatMessage.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - CHAT_RETENTION_DAYS * 86_400_000) } } });
  return r.count;
}
