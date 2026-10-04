import type { PrismaClient } from "@prisma/client";
import { QUOTA_COST, YoutubeApiError, YoutubeQuotaError, type VideoInfo, type YoutubeClient } from "./client";
import { markQuotaExhausted, reserveQuota, type QuotaPurpose } from "./quota";

// 유튜브 거부 사유·문구와 할당량을 거치는 호출. 판매자 연결(service.ts)과 동기화(sync.ts)가 함께 쓴다.
export type YoutubeRejection =
  | "not_configured"
  | "invalid_url"
  | "channel_not_found"
  | "video_not_found"
  | "not_live_video"
  | "live_ended"
  | "other_channel"
  | "already_linked"
  | "no_channel"
  | "no_live_found"
  | "quota_exhausted"
  | "seller_quota_exhausted"
  | "youtube_unavailable";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const YOUTUBE_MESSAGES: Record<YoutubeRejection, string> = {
  not_configured: "유튜브 연동이 아직 준비되지 않았습니다",
  invalid_url: "유튜브 채널 주소 또는 방송 주소를 확인해 주십시오",
  channel_not_found: "채널을 찾을 수 없습니다. 주소를 확인해 주십시오",
  video_not_found: "방송을 찾을 수 없습니다. 공개 방송인지 확인해 주십시오",
  not_live_video: "라이브 방송 주소만 연결할 수 있습니다",
  live_ended: "이미 끝난 방송입니다",
  other_channel: "연결한 채널의 방송만 연결할 수 있습니다",
  already_linked: "이미 연결된 방송이 있습니다. 연결을 해제한 뒤 다시 시도해 주십시오",
  no_channel: "채널을 먼저 연결해 주십시오",
  no_live_found: "예정되었거나 진행 중인 방송이 없습니다",
  quota_exhausted: "오늘 유튜브 조회 한도를 모두 사용했습니다. 내일 다시 시도해 주십시오",
  seller_quota_exhausted: "오늘 이 쇼핑몰의 유튜브 조회 한도를 모두 사용했습니다. 내일 다시 시도해 주십시오",
  youtube_unavailable: "유튜브에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주십시오",
};

export type YoutubeResult<T> = { ok: true; value: T } | { ok: false; reason: YoutubeRejection };

export class Rejected extends Error {
  constructor(readonly reason: YoutubeRejection) {
    super(reason);
  }
}

// 할당량을 예약하고 부른다. 초과·실패는 거부 사유로 바꾼다.
export async function callYoutube<T>(
  db: PrismaClient,
  method: keyof typeof QUOTA_COST,
  purpose: QuotaPurpose,
  sellerId: string | undefined,
  now: Date,
  fn: () => Promise<T>,
): Promise<T> {
  const r = await reserveQuota(db, { units: QUOTA_COST[method], purpose, sellerId }, now);
  if (!r.ok) throw new Rejected(r.reason);
  try {
    return await fn();
  } catch (e) {
    if (e instanceof YoutubeQuotaError) {
      await markQuotaExhausted(db, now);
      throw new Rejected("quota_exhausted");
    }
    if (e instanceof YoutubeApiError) {
      console.error(`[youtube] ${method} ${e.message}`);
      throw new Rejected("youtube_unavailable");
    }
    throw e;
  }
}

export async function guard<T>(fn: () => Promise<T>): Promise<YoutubeResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, reason: e.reason };
    throw e;
  }
}

export const liveStatusOf = (v: VideoInfo): "UPCOMING" | "LIVE" | "ENDED" =>
  v.actualEndAt || (v.broadcast === "none" && v.actualStartAt) ? "ENDED" : v.broadcast === "live" || v.actualStartAt ? "LIVE" : "UPCOMING";

// 채널의 예정·진행 중 방송 하나(진행 중 우선, 그다음 가장 이른 예정). 동기화의 자동 찾기도 쓴다.
export async function discoverLive(db: PrismaClient, client: YoutubeClient, channel: { sellerId: string; uploadsPlaylistId: string; channelId: string }, now: Date) {
  const ids = await callYoutube(db, "playlistItems.list", "link", channel.sellerId, now, () => client.latestUploads(channel.uploadsPlaylistId));
  await db.youtubeChannelLink.update({ where: { sellerId: channel.sellerId }, data: { checkedAt: now } });
  if (ids.length === 0) return null;
  const videos = await callYoutube(db, "videos.list", "link", channel.sellerId, now, () => client.videos(ids));
  const open = videos.filter((v) => v.isLiveVideo && v.channelId === channel.channelId && liveStatusOf(v) !== "ENDED");
  open.sort((a, b) => Number(liveStatusOf(b) === "LIVE") - Number(liveStatusOf(a) === "LIVE") || (a.scheduledStartAt?.getTime() ?? 0) - (b.scheduledStartAt?.getTime() ?? 0));
  return open[0] ?? null;
}

export function youtubeRejectionStatus(reason: YoutubeRejection): number {
  if (reason === "invalid_url") return 400;
  if (reason === "channel_not_found" || reason === "video_not_found" || reason === "no_live_found") return 404;
  if (reason === "quota_exhausted" || reason === "seller_quota_exhausted") return 429;
  if (reason === "youtube_unavailable") return 502;
  return 409;
}
