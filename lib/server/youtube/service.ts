import type { PrismaClient, YoutubeLiveLink } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import type { VideoInfo, YoutubeClient } from "./client";
import { Rejected, callYoutube, discoverLive, guard, liveStatusOf } from "./call";
import { parseYoutubeRef } from "./parse";
import { applyVideoState } from "./sync";

// 파트너스 유튜브 채널·방송 연결(API 키만, 공개 방송 읽기만). 판매자 격리: 모든 조회·변경은 ctx.sellerId 조건.
// 키가 없으면(client=null) 조회는 configured:false(「연결 안 됨」), 변경은 not_configured로 거부한다(503 아님).
const liveView = (l: YoutubeLiveLink) => ({
  id: l.id,
  videoId: l.videoId,
  url: `https://www.youtube.com/watch?v=${l.videoId}`,
  title: l.title,
  status: l.status.toLowerCase(),
  scheduledStartAt: l.scheduledStartAt,
  actualStartAt: l.actualStartAt,
  actualEndAt: l.actualEndAt,
  broadcastSessionId: l.broadcastSessionId,
  autoStarted: l.autoStarted,
  checkedAt: l.checkedAt,
});

export async function youtubeStatus(db: PrismaClient, ctx: TenantContext, configured: boolean) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const [channel, live] = await Promise.all([
    db.youtubeChannelLink.findUnique({ where: { sellerId: ctx.sellerId } }),
    db.youtubeLiveLink.findFirst({ where: { sellerId: ctx.sellerId, status: { in: ["UPCOMING", "LIVE"] } } }),
  ]);
  return {
    configured,
    channel: channel ? { channelId: channel.channelId, title: channel.title, url: `https://www.youtube.com/channel/${channel.channelId}`, connectedAt: channel.connectedAt } : null,
    live: live ? liveView(live) : null,
  };
}

export async function connectChannel(db: PrismaClient, ctx: TenantContext, client: YoutubeClient | null, input: unknown, now = new Date()) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  return guard(async () => {
    if (!client) throw new Rejected("not_configured");
    const ref = parseYoutubeRef(input);
    if (!ref || ref.kind === "video") throw new Rejected("invalid_url");
    const info = await callYoutube(db, "channels.list", "link", ctx.sellerId, now, () => client.channel(ref.kind === "channel" ? { channelId: ref.channelId } : { handle: ref.handle }));
    if (!info) throw new Rejected("channel_not_found");
    const data = { channelId: info.channelId, title: info.title, uploadsPlaylistId: info.uploadsPlaylistId, connectedAt: now, checkedAt: null };
    const before = await db.youtubeChannelLink.findUnique({ where: { sellerId: ctx.sellerId }, select: { channelId: true } });
    await db.youtubeChannelLink.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "youtube.channel.connect",
      targetType: "YoutubeChannelLink",
      targetId: ctx.sellerId,
      before: before ?? undefined,
      after: { channelId: info.channelId },
    });
    return { channelId: info.channelId, title: info.title };
  });
}

export async function disconnectChannel(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const r = await db.youtubeChannelLink.deleteMany({ where: { sellerId: ctx.sellerId } });
  if (r.count) {
    await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "youtube.channel.disconnect", targetType: "YoutubeChannelLink", targetId: ctx.sellerId });
  }
  return { disconnected: r.count > 0 };
}

// 방송 영상 연결. 채널을 연결해 두었으면 그 채널의 방송만. 진행 중 연결은 판매자당 1개.
async function linkVideo(db: PrismaClient, ctx: TenantContext, v: VideoInfo, now: Date) {
  if (!v.isLiveVideo) throw new Rejected("not_live_video");
  const status = liveStatusOf(v);
  if (status === "ENDED") throw new Rejected("live_ended");
  const channel = await db.youtubeChannelLink.findUnique({ where: { sellerId: ctx.sellerId }, select: { channelId: true } });
  if (channel && channel.channelId !== v.channelId) throw new Rejected("other_channel");
  const active = await db.youtubeLiveLink.findFirst({ where: { sellerId: ctx.sellerId, status: { in: ["UPCOMING", "LIVE"] } } });
  if (active) {
    if (active.videoId === v.videoId) return liveView(active);
    throw new Rejected("already_linked");
  }
  let link: YoutubeLiveLink;
  try {
    link = await db.youtubeLiveLink.create({
      data: {
        sellerId: ctx.sellerId,
        videoId: v.videoId,
        title: v.title,
        status: "UPCOMING",
        scheduledStartAt: v.scheduledStartAt,
        checkedAt: now,
      },
    });
  } catch (e) {
    // 동시에 두 번 연결(부분 유니크 인덱스)
    if ((e as { code?: string }).code === "P2002") throw new Rejected("already_linked");
    throw e;
  }
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "youtube.live.link",
    targetType: "YoutubeLiveLink",
    targetId: link.id,
    after: { videoId: v.videoId },
  });
  // 연결할 때 이미 진행 중이면 다음 주기를 기다리지 않고 바로 방송을 시작한다(받아 둔 영상 정보로, 추가 호출 없음)
  return liveView(await applyVideoState(db, link, v, now));
}

export async function connectLive(db: PrismaClient, ctx: TenantContext, client: YoutubeClient | null, input: unknown, now = new Date()) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  return guard(async () => {
    if (!client) throw new Rejected("not_configured");
    const ref = parseYoutubeRef(input);
    if (!ref || ref.kind !== "video") throw new Rejected("invalid_url");
    const [v] = await callYoutube(db, "videos.list", "link", ctx.sellerId, now, () => client.videos([ref.videoId]));
    if (!v) throw new Rejected("video_not_found");
    return linkVideo(db, ctx, v, now);
  });
}

// 연결한 채널의 최근 업로드 5개에서 예정·진행 중 방송을 찾아 연결한다(2단위). search.list는 쓰지 않는다.
export async function findChannelLive(db: PrismaClient, ctx: TenantContext, client: YoutubeClient | null, now = new Date()) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  return guard(async () => {
    if (!client) throw new Rejected("not_configured");
    const channel = await db.youtubeChannelLink.findUnique({ where: { sellerId: ctx.sellerId } });
    if (!channel) throw new Rejected("no_channel");
    const v = await discoverLive(db, client, channel, now);
    if (!v) throw new Rejected("no_live_found");
    return linkVideo(db, ctx, v, now);
  });
}

// 연결 해제. 이미 시작된 방송(BroadcastSession)은 그대로 두고 수동으로 끝낸다.
export async function unlinkLive(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "BROADCAST_RUN");
  const active = await db.youtubeLiveLink.findFirst({ where: { sellerId: ctx.sellerId, status: { in: ["UPCOMING", "LIVE"] } }, select: { id: true } });
  if (!active) return { unlinked: false };
  const r = await db.youtubeLiveLink.updateMany({ where: { id: active.id, sellerId: ctx.sellerId, status: { in: ["UPCOMING", "LIVE"] } }, data: { status: "UNLINKED" } });
  if (r.count) {
    await writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "youtube.live.unlink", targetType: "YoutubeLiveLink", targetId: active.id });
  }
  return { unlinked: r.count > 0 };
}
