import type { PrismaClient } from "@prisma/client";
import { shopOpen } from "../buyers/signup";

// 구매자 쇼핑몰의 「지금 방송 중」 공개 정보(로그인 없이).
// - live: 이 판매자의 진행 중(LIVE) 방송 세션이 있는지. 방송 시작은 파트너스가 하고, 유튜브 연결은 방송 보기 주소에만 쓴다.
// - watchUrl: 유튜브 방송 연결이 실제로 진행 중(LIVE)일 때만 보기 주소. 예정(UPCOMING)·끝난 연결, 연결 없음은 null. 방송 세션에 붙은 연결을 먼저 본다.
// - title: 방송 제목(없으면 유튜브 영상 제목, 그래도 없으면 null). startedAt은 방송 시작 시각.
// 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰은 null(404). 방송 중이 아니면 live=false에 나머지는 null.
export type ShopLive = { live: boolean; title: string | null; startedAt: Date | null; watchUrl: string | null };

export const youtubeWatchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

export async function shopLiveStatus(db: PrismaClient, slug: string): Promise<ShopLive | null> {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const session = await db.broadcastSession.findFirst({ where: { sellerId: shop.id, status: "LIVE" }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], select: { id: true, title: true, startedAt: true } });
  if (!session) return { live: false, title: null, startedAt: null, watchUrl: null };
  const links = await db.youtubeLiveLink.findMany({ where: { sellerId: shop.id, status: "LIVE" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { videoId: true, title: true, broadcastSessionId: true } });
  const link = links.find((l) => l.broadcastSessionId === session.id) ?? links[0] ?? null;
  return { live: true, title: session.title ?? link?.title ?? null, startedAt: session.startedAt, watchUrl: link ? youtubeWatchUrl(link.videoId) : null };
}
