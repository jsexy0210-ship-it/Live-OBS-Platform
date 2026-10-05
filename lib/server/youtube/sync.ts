import type { PrismaClient, YoutubeLiveLink } from "@prisma/client";
import { sellerFeatures } from "../billing/features";
import { sellerAccessFor } from "../billing/subscription";
import { recordHeartbeat } from "../ops/metrics";
import { endBroadcast, startBroadcast } from "../queue/service";
import type { TenantContext } from "../tenant/context";
import { Rejected, callYoutube, discoverLive, liveStatusOf } from "./call";
import { VIDEOS_PER_CALL, type VideoInfo, type YoutubeClient } from "./client";
import { QUOTA_WARN_RATIO, quotaUsage } from "./quota";
import { chatDefaultFor } from "./settings";

// 유튜브 방송 상태 동기화(worker.ts가 60초마다, 한 인스턴스만). 방송(BroadcastSession) 시작·종료는 queue/service의
// startBroadcast·endBroadcast를 시스템 행위자로 부른다(수동 시작·종료는 그대로). 판매자별로 그 판매자 연결만 다룬다.
// - 예정→진행: 방송 자동 시작. 이미 수동으로 켠 방송이 있으면 새로 만들지 않고 그 방송에 붙는다.
//   정지·이용 만료·요금제 기능(OVERLAY) 없음이면 시작하지 않는다(유튜브 상태만 기록, 다음 주기에 다시 판단).
// - 진행→종료(또는 영상 삭제·비공개): 붙은 방송을 끝낸다. 개봉 중이면(opening_in_progress) 다음 주기에 다시 시도.
//   다른 방송이 진행 중이거나 이미 수동으로 끝냈으면 건드리지 않는다.
// - 채널만 연결하고 진행 중 연결이 없는 판매자는 DISCOVER_INTERVAL_MS마다 새 방송을 찾는다(판매자당 2단위).
export const SYNC_INTERVAL_MS = 60_000;
export const DISCOVER_INTERVAL_MS = 15 * 60_000;
const ACTIVE = ["UPCOMING", "LIVE"] as const;

const systemCtx = (sellerId: string): TenantContext => ({ sellerId, actorType: "SYSTEM", actorId: "", isOwner: true, permissions: [], readOnly: false });

async function canAutoStart(db: PrismaClient, sellerId: string, now: Date): Promise<boolean> {
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { status: true } });
  if (seller?.status !== "ACTIVE") return false;
  if ((await sellerAccessFor(db, sellerId, now)) === "expired") return false;
  return (await sellerFeatures(db, sellerId, now)).includes("OVERLAY");
}

async function save(db: PrismaClient, link: YoutubeLiveLink, data: Partial<YoutubeLiveLink>): Promise<YoutubeLiveLink> {
  // 그 사이 해제(UNLINKED)됐으면 덮어쓰지 않는다
  const r = await db.youtubeLiveLink.updateMany({ where: { id: link.id, sellerId: link.sellerId, status: { in: [...ACTIVE] } }, data });
  return r.count ? { ...link, ...data } : ((await db.youtubeLiveLink.findUnique({ where: { id: link.id } })) ?? link);
}

// 받은 영상 상태(null이면 삭제·비공개로 못 찾음)를 연결 하나에 반영한다.
export async function applyVideoState(db: PrismaClient, link: YoutubeLiveLink, v: VideoInfo | null, now: Date): Promise<YoutubeLiveLink> {
  if (!ACTIVE.includes(link.status as (typeof ACTIVE)[number])) return link;
  const state = v ? liveStatusOf(v) : "ENDED";
  const base = {
    checkedAt: now,
    ...(v ? { title: v.title || link.title, scheduledStartAt: v.scheduledStartAt, actualStartAt: v.actualStartAt, actualEndAt: v.actualEndAt } : {}),
  };
  if (state === "UPCOMING") return save(db, link, base);

  if (state === "LIVE") {
    const data: Partial<YoutubeLiveLink> = { ...base, status: "LIVE", liveChatId: v?.liveChatId ?? link.liveChatId };
    if (!link.broadcastSessionId && (await canAutoStart(db, link.sellerId, now))) {
      const r = await startBroadcast(db, systemCtx(link.sellerId), { title: (v?.title || link.title).slice(0, 100), now });
      if (r.ok) Object.assign(data, { broadcastSessionId: r.value.broadcastSessionId, autoStarted: true });
      else if (r.reason === "already_live") {
        const live = await db.broadcastSession.findFirst({ where: { sellerId: link.sellerId, status: "LIVE" }, select: { id: true } });
        if (live) Object.assign(data, { broadcastSessionId: live.id, autoStarted: false });
      } else console.error(`[youtube] auto start ${link.id}: ${r.reason}`);
    }
    return save(db, link, data);
  }

  // 종료: 붙은 방송이 아직 진행 중이면 끝낸다. 못 끝내면(개봉 중 등) LIVE로 두고 다음 주기에 다시 시도.
  if (link.broadcastSessionId) {
    const session = await db.broadcastSession.findFirst({ where: { id: link.broadcastSessionId, sellerId: link.sellerId }, select: { status: true } });
    if (session?.status === "LIVE") {
      const r = await endBroadcast(db, systemCtx(link.sellerId), { broadcastSessionId: link.broadcastSessionId, now });
      if (!r.ok && r.reason !== "not_live") {
        console.error(`[youtube] auto end ${link.id}: ${r.reason}`);
        return save(db, link, { ...base, status: "LIVE" });
      }
    }
  }
  return save(db, link, { ...base, status: "ENDED", liveChatId: null, chatPageToken: null, chatNextPollAt: null });
}

export type SyncReport = { checked: number; discovered: number; quotaRatio: number; stopped?: string };

export async function syncYoutube(db: PrismaClient, client: YoutubeClient, now = new Date()): Promise<SyncReport> {
  const report: SyncReport = { checked: 0, discovered: 0, quotaRatio: 0 };
  try {
    // 1) 진행 중 연결의 영상 상태를 50개씩 묶어 확인(묶음당 1단위, 전체 몫)
    const links = await db.youtubeLiveLink.findMany({ where: { status: { in: [...ACTIVE] } }, orderBy: { id: "asc" } });
    for (let i = 0; i < links.length; i += VIDEOS_PER_CALL) {
      const batch = links.slice(i, i + VIDEOS_PER_CALL);
      const videos = await callYoutube(db, "videos.list", "status", undefined, now, () => client.videos([...new Set(batch.map((l) => l.videoId))]));
      const byId = new Map(videos.map((v) => [v.videoId, v]));
      for (const link of batch) {
        try {
          await applyVideoState(db, link, byId.get(link.videoId) ?? null, now);
          report.checked++;
        } catch (e) {
          console.error(`[youtube] sync ${link.id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    // 2) 채널만 연결된 판매자의 새 방송 찾기(판매자 몫)
    const due = new Date(now.getTime() - DISCOVER_INTERVAL_MS);
    const channels = await db.youtubeChannelLink.findMany({
      where: { OR: [{ checkedAt: null }, { checkedAt: { lt: due } }], seller: { youtubeLives: { none: { status: { in: [...ACTIVE] } } } } },
      orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }],
    });
    for (const channel of channels) {
      try {
        if (!(await canAutoStart(db, channel.sellerId, now))) continue;
        const v = await discoverLive(db, client, channel, now);
        if (!v) continue;
        const link = await db.youtubeLiveLink.create({
          data: {
            sellerId: channel.sellerId,
            videoId: v.videoId,
            title: v.title,
            scheduledStartAt: v.scheduledStartAt,
            checkedAt: now,
            chatEnabled: await chatDefaultFor(db, channel.sellerId),
          },
        });
        report.discovered++;
        await applyVideoState(db, link, v, now);
      } catch (e) {
        if (e instanceof Rejected && e.reason === "quota_exhausted") throw e;
        // 판매자 몫 초과·동시 연결(유니크) 등은 그 판매자만 건너뛴다
        if (!(e instanceof Rejected) && (e as { code?: string }).code !== "P2002") console.error(`[youtube] discover ${channel.sellerId}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    if (!(e instanceof Rejected)) throw e;
    report.stopped = e.reason;
  }
  report.quotaRatio = (await quotaUsage(db, now)).ratio;
  return report;
}

// 할당량 80%를 넘으면 경고를 남긴다(로그 + 감시 heartbeat failed: 앱 밖 수집기가 알림). 넘지 않으면 done.
export async function reportQuota(db: PrismaClient, ratio: number, now: Date): Promise<void> {
  const over = ratio >= QUOTA_WARN_RATIO;
  if (over) console.warn(`[youtube] 하루 할당량 ${Math.round(ratio * 100)}% 사용`);
  await recordHeartbeat(db, "youtube.quota", over ? "failed" : "done", now, over ? `quota ${Math.round(ratio * 100)}%` : undefined);
}
