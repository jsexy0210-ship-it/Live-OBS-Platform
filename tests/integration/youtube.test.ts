import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as statusRoute } from "../../app/api/seller/youtube/route";
import { PUT as channelRoute } from "../../app/api/seller/youtube/channel/route";
import { GET as summaryRoute } from "../../app/api/seller/broadcast/summary/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { GET as settingsGet, PUT as settingsPut } from "../../app/api/seller/youtube/settings/route";
import { GET as usageRoute } from "../../app/api/seller/youtube/usage/route";
import { DELETE as chatsDelete } from "../../app/api/seller/youtube/chats/route";
import { GET as chatStatusRoute } from "../../app/api/seller/youtube/live/chat-status/route";
import { GET as matchesRoute } from "../../app/api/seller/youtube/live/chat-matches/route";
import { PUT as chatRoute } from "../../app/api/seller/youtube/live/chat/route";
import { CHAT_NOTICE, chatStatus, collectChats, purgeOldChats } from "../../lib/server/youtube/chat";
import { YoutubeQuotaError, type ChannelInfo, type ChatPage, type VideoInfo, type YoutubeClient } from "../../lib/server/youtube/client";
import { quotaDay, reserveQuota } from "../../lib/server/youtube/quota";
import { chatUsage } from "../../lib/server/youtube/settings";
import { connectChannel, connectLive, findChannelLive, unlinkLive, youtubeStatus } from "../../lib/server/youtube/service";
import { syncYoutube } from "../../lib/server/youtube/sync";
import { runYoutubeSyncOnce, startYoutubeWorker } from "../../lib/server/youtube/worker";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 유튜브 연동 PR 1: 채널·방송 연결, 방송 자동 시작·종료, 할당량, 판매자 격리, 키 없음. 유튜브 호출은 모두 모의.
beforeEach(resetDb);
afterEach(() => {
  delete process.env.YOUTUBE_API_KEY;
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const CH_A = "UCaaaaaaaaaaaaaaaaaaaaaa";
const CH_B = "UCbbbbbbbbbbbbbbbbbbbbbb";
const VID_A = "aaaaaaaaaa1";
const VID_B = "bbbbbbbbbb1";
const NOW = new Date("2026-10-05T03:00:00Z");

// 모의 유튜브: 채널·영상 표를 바꿔 가며 상태를 흉내 낸다. calls로 호출 수를 센다.
function fakeYoutube() {
  const channels = new Map<string, ChannelInfo>();
  const uploads = new Map<string, string[]>();
  const videos = new Map<string, VideoInfo>();
  const calls: string[] = [];
  const chatPages: ChatPage[] = [];
  const chatTokens: (string | null)[] = [];
  let quotaExceeded = false;
  const client: YoutubeClient = {
    async channel(ref) {
      calls.push("channels.list");
      if (quotaExceeded) throw new YoutubeQuotaError();
      return "channelId" in ref ? (channels.get(ref.channelId) ?? null) : ([...channels.values()].find((c) => `@${c.title}` === ref.handle) ?? null);
    },
    async latestUploads(id) {
      calls.push("playlistItems.list");
      return uploads.get(id) ?? [];
    },
    async videos(ids) {
      calls.push("videos.list");
      if (quotaExceeded) throw new YoutubeQuotaError();
      return ids.map((i) => videos.get(i)).filter((v): v is VideoInfo => !!v);
    },
    async chatMessages(_id, token) {
      calls.push("liveChatMessages.list");
      chatTokens.push(token);
      if (quotaExceeded) throw new YoutubeQuotaError();
      return chatPages.shift() ?? { messages: [], nextPageToken: token, pollingIntervalMillis: 5_000, ended: false };
    },
  };
  const video = (id: string, channelId: string, p: Partial<VideoInfo> = {}) => {
    const v: VideoInfo = { videoId: id, channelId, title: "방송", broadcast: "upcoming", isLiveVideo: true, scheduledStartAt: NOW, actualStartAt: null, actualEndAt: null, liveChatId: null, ...p };
    videos.set(id, v);
    return v;
  };
  const goLive = (id: string) => Object.assign(videos.get(id)!, { broadcast: "live", actualStartAt: NOW, liveChatId: "chat-" + id });
  const end = (id: string) => Object.assign(videos.get(id)!, { broadcast: "none", actualEndAt: NOW, liveChatId: null });
  channels.set(CH_A, { channelId: CH_A, title: "shopa", uploadsPlaylistId: "UUa" });
  channels.set(CH_B, { channelId: CH_B, title: "shopb", uploadsPlaylistId: "UUb" });
  return { client, calls, video, goLive, end, uploads, videos, chatPages, chatTokens, exceed: () => (quotaExceeded = true) };
}

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const runner = await createSellerUser(seller.id, { permissions: ["BROADCAST_RUN"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  const ctx = { sellerId: seller.id, actorType: "SELLER_USER" as const, actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx, owner, runner, other };
}
async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
const get = (cookie: string) => statusRoute(new Request(BASE + "/api/seller/youtube", { headers: { host: "localhost:3000", cookie } }));
const putChannel = (cookie: string, url: string) =>
  channelRoute(new Request(BASE + "/api/seller/youtube/channel", { method: "PUT", headers: { host: "localhost:3000", origin: BASE, cookie, "content-type": "application/json" }, body: JSON.stringify({ url }) }));

describe("키 없음·권한", () => {
  it("키가 없으면 configured:false, 연결은 409 not_configured(503 아님)", async () => {
    const s = await shop();
    const c = await cookieOf(s.owner.email);
    const res = await get(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, channel: null, live: null, chatNotice: CHAT_NOTICE });
    const put = await putChannel(c, "@shopa");
    expect(put.status).toBe(409);
    expect(await put.json()).toMatchObject({ error: "not_configured" });
  });
  it("타이머는 키가 없거나 SCHEDULER_DISABLED=1이면 시작하지 않는다", () => {
    expect(startYoutubeWorker(db, {})).toBeNull();
    process.env.YOUTUBE_API_KEY = "k";
    expect(startYoutubeWorker(db, { SCHEDULER_DISABLED: "1" })).toBeNull();
  });
  it("BROADCAST_RUN 직원은 되고, 없는 직원은 403", async () => {
    const s = await shop();
    expect((await get(await cookieOf(s.runner.email))).status).toBe(200);
    expect((await get(await cookieOf(s.other.email))).status).toBe(403);
    expect((await putChannel(await cookieOf(s.other.email), "@shopa")).status).toBe(403);
  });
});

describe("채널·방송 연결", () => {
  it("채널 연결은 1단위(전체·판매자 몫), 다른 채널 방송은 거부, 진행 중 연결은 하나", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    expect(await connectChannel(db, s.ctx, yt.client, "https://www.youtube.com/@shopa", NOW)).toEqual({ ok: true, value: { channelId: CH_A, title: "shopa" } });
    const usage = await db.youtubeQuotaUsage.findMany({ where: { day: quotaDay(NOW) } });
    expect(Object.fromEntries(usage.map((u) => [u.scope, u.units]))).toEqual({ all: 1, [s.seller.id]: 1 });

    yt.video(VID_B, CH_B);
    expect(await connectLive(db, s.ctx, yt.client, `https://youtu.be/${VID_B}`, NOW)).toEqual({ ok: false, reason: "other_channel" });
    yt.video(VID_A, CH_A, { isLiveVideo: false, broadcast: "none" });
    expect(await connectLive(db, s.ctx, yt.client, VID_A, NOW)).toEqual({ ok: false, reason: "not_live_video" });
    yt.video(VID_A, CH_A);
    const r = await connectLive(db, s.ctx, yt.client, `https://www.youtube.com/watch?v=${VID_A}`, NOW);
    expect(r).toMatchObject({ ok: true, value: { videoId: VID_A, status: "upcoming", broadcastSessionId: null } });
    // 같은 영상은 그대로, 다른 영상은 already_linked
    expect(await connectLive(db, s.ctx, yt.client, VID_A, NOW)).toMatchObject({ ok: true });
    yt.video("aaaaaaaaaa2", CH_A);
    expect(await connectLive(db, s.ctx, yt.client, "aaaaaaaaaa2", NOW)).toEqual({ ok: false, reason: "already_linked" });
    expect(await unlinkLive(db, s.ctx)).toEqual({ unlinked: true });
    expect(await connectLive(db, s.ctx, yt.client, "aaaaaaaaaa2", NOW)).toMatchObject({ ok: true });
  });

  it("판매자 격리: 다른 판매자의 연결은 보이지 않고 해제되지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    await connectLive(db, a.ctx, yt.client, VID_A, NOW);
    expect((await youtubeStatus(db, b.ctx, true)).live).toBeNull();
    expect(await unlinkLive(db, b.ctx)).toEqual({ unlinked: false });
    expect((await youtubeStatus(db, a.ctx, true)).live).toMatchObject({ videoId: VID_A });
  });

  it("채널을 바꾸면 예정 방송 연결은 해제되고, 방송 중이면 바꾸지 못한다(같은 채널 재연결은 그대로)", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    await connectChannel(db, s.ctx, yt.client, CH_A, NOW);
    yt.video(VID_A, CH_A);
    await connectLive(db, s.ctx, yt.client, VID_A, NOW);
    await db.youtubeLiveLink.updateMany({ where: { sellerId: s.seller.id }, data: { chatEnabled: true } });
    // 같은 채널 다시 연결: 방송 연결 유지
    await connectChannel(db, s.ctx, yt.client, CH_A, NOW);
    expect((await youtubeStatus(db, s.ctx, true)).live).toMatchObject({ videoId: VID_A });
    // 방송 중이면 거부, 채널·방송 연결 모두 그대로
    await db.youtubeLiveLink.updateMany({ where: { sellerId: s.seller.id }, data: { status: "LIVE" } });
    expect(await connectChannel(db, s.ctx, yt.client, CH_B, NOW)).toEqual({ ok: false, reason: "live_in_progress" });
    expect((await db.youtubeChannelLink.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).channelId).toBe(CH_A);
    expect((await db.youtubeLiveLink.findFirstOrThrow({ where: { sellerId: s.seller.id } })).status).toBe("LIVE");
    // 예정 상태면 바꾸고 이전 방송 연결(채팅 수집 포함)은 해제
    await db.youtubeLiveLink.updateMany({ where: { sellerId: s.seller.id }, data: { status: "UPCOMING" } });
    expect(await connectChannel(db, s.ctx, yt.client, CH_B, NOW)).toEqual({ ok: true, value: { channelId: CH_B, title: "shopb" } });
    expect((await db.youtubeLiveLink.findFirstOrThrow({ where: { sellerId: s.seller.id } })).status).toBe("UNLINKED");
    expect((await youtubeStatus(db, s.ctx, true)).live).toBeNull();
  });

  it("지금 방송 찾기: 채널 최근 업로드에서 진행 중을 먼저 고른다", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    expect(await findChannelLive(db, s.ctx, yt.client, NOW)).toEqual({ ok: false, reason: "no_channel" });
    await connectChannel(db, s.ctx, yt.client, CH_A, NOW);
    yt.uploads.set("UUa", ["old00000001", VID_A, "aaaaaaaaaa2"]);
    yt.video("old00000001", CH_A, { broadcast: "none", actualStartAt: NOW, actualEndAt: NOW });
    yt.video(VID_A, CH_A);
    yt.video("aaaaaaaaaa2", CH_A);
    yt.goLive("aaaaaaaaaa2");
    const r = await findChannelLive(db, s.ctx, yt.client, NOW);
    expect(r).toMatchObject({ ok: true, value: { videoId: "aaaaaaaaaa2", status: "live" } });
  });
});

describe("방송 자동 시작·종료", () => {
  it("예정 → 진행이면 방송을 시작하고(SYSTEM 기록), 종료되면 끝낸다", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    await connectLive(db, s.ctx, yt.client, VID_A, NOW);
    await syncYoutube(db, yt.client, NOW);
    expect(await db.broadcastSession.count({ where: { sellerId: s.seller.id } })).toBe(0);

    yt.goLive(VID_A);
    await syncYoutube(db, yt.client, NOW);
    const link = await db.youtubeLiveLink.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } });
    expect(link).toMatchObject({ status: "LIVE", autoStarted: true, liveChatId: "chat-" + VID_A });
    const session = await db.broadcastSession.findUniqueOrThrow({ where: { id: link.broadcastSessionId! } });
    expect(session.status).toBe("LIVE");
    const audit = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id, action: "broadcast.start" } });
    expect(audit).toMatchObject({ actorType: "SYSTEM", actorId: null });

    // 방송 대시보드 요약에도 지금 방송으로 잡힌다
    const summary = await summaryRoute(new Request(BASE + "/api/seller/broadcast/summary", { headers: { host: "localhost:3000", cookie: await cookieOf(s.owner.email) } }));
    expect((await summary.json()).broadcast).toMatchObject({ id: session.id, status: "live" });

    // 다음 주기에 다시 시작하지 않는다
    await syncYoutube(db, yt.client, NOW);
    expect(await db.broadcastSession.count({ where: { sellerId: s.seller.id } })).toBe(1);

    yt.end(VID_A);
    await syncYoutube(db, yt.client, NOW);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("ENDED");
    expect((await db.youtubeLiveLink.findUniqueOrThrow({ where: { id: link.id } })).status).toBe("ENDED");
  });

  it("이미 수동으로 켠 방송이 있으면 새로 만들지 않고 붙는다", async () => {
    const s = await shop();
    const manual = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", title: "수동" } });
    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    yt.goLive(VID_A);
    const r = await connectLive(db, s.ctx, yt.client, VID_A, NOW);
    expect(r).toMatchObject({ ok: true, value: { status: "live", broadcastSessionId: manual.id, autoStarted: false } });
    expect(await db.broadcastSession.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });

  it("정지된 판매자는 자동 시작하지 않는다", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    await connectLive(db, s.ctx, yt.client, VID_A, NOW);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    yt.goLive(VID_A);
    await syncYoutube(db, yt.client, NOW);
    expect(await db.broadcastSession.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await db.youtubeLiveLink.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).status).toBe("LIVE");
  });

  it("다른 판매자의 방송은 건드리지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const bLive = await db.broadcastSession.create({ data: { sellerId: b.seller.id, status: "LIVE" } });
    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    await connectLive(db, a.ctx, yt.client, VID_A, NOW);
    yt.goLive(VID_A);
    await syncYoutube(db, yt.client, NOW);
    yt.end(VID_A);
    await syncYoutube(db, yt.client, NOW);
    expect((await db.broadcastSession.findUniqueOrThrow({ where: { id: bLive.id } })).status).toBe("LIVE");
  });

  it("채널만 연결해도 새 방송을 찾아 연결한다(15분 간격)", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    await connectChannel(db, s.ctx, yt.client, CH_A, NOW);
    yt.uploads.set("UUa", [VID_A]);
    yt.video(VID_A, CH_A);
    const r = await syncYoutube(db, yt.client, NOW);
    expect(r.discovered).toBe(1);
    yt.calls.length = 0;
    // 진행 중 연결이 있으면 찾지 않는다(상태 확인만 1회)
    await syncYoutube(db, yt.client, new Date(NOW.getTime() + 20 * 60_000));
    expect(yt.calls).toEqual(["videos.list"]);
  });
});

describe("할당량", () => {
  it("전체·판매자 상한을 넘으면 예약하지 않는다", async () => {
    const s = await shop();
    const limits = { daily: 10, perSeller: 3 };
    for (let i = 0; i < 3; i++) expect((await reserveQuota(db, { units: 1, purpose: "link", sellerId: s.seller.id }, NOW, limits)).ok).toBe(true);
    expect(await reserveQuota(db, { units: 1, purpose: "link", sellerId: s.seller.id }, NOW, limits)).toEqual({ ok: false, reason: "seller_quota_exhausted" });
    // 판매자 몫에서 거부되면 전체 몫도 되돌린다
    expect((await db.youtubeQuotaUsage.findUniqueOrThrow({ where: { day_scope: { day: quotaDay(NOW), scope: "all" } } })).units).toBe(3);
    for (let i = 0; i < 6; i++) expect((await reserveQuota(db, { units: 1, purpose: "status" }, NOW, limits)).ok).toBe(true);
    // 채팅은 95%(9)까지
    expect(await reserveQuota(db, { units: 1, purpose: "chat" }, NOW, limits)).toEqual({ ok: false, reason: "quota_exhausted" });
    expect((await reserveQuota(db, { units: 1, purpose: "status" }, NOW, limits)).ok).toBe(true);
    expect(await reserveQuota(db, { units: 1, purpose: "status" }, NOW, limits)).toEqual({ ok: false, reason: "quota_exhausted" });
  });

  it("403 quotaExceeded를 받으면 그날은 더 부르지 않는다", async () => {
    const s = await shop();
    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    await connectLive(db, s.ctx, yt.client, VID_A, NOW);
    yt.exceed();
    expect((await syncYoutube(db, yt.client, NOW)).stopped).toBe("quota_exhausted");
    yt.calls.length = 0;
    const r = await syncYoutube(db, yt.client, NOW);
    expect(r.stopped).toBe("quota_exhausted");
    expect(yt.calls).toEqual([]);
    expect(r.quotaRatio).toBe(1);
  });
});

const msg = (id: string, authorName: string, at = NOW) => ({ messageId: id, authorChannelId: "UCx" + id, authorName, text: "주문할게요", publishedAt: at });
const putChat = (cookie: string, enabled: unknown) =>
  chatRoute(new Request(BASE + "/api/seller/youtube/live/chat", { method: "PUT", headers: { host: "localhost:3000", origin: BASE, cookie, "content-type": "application/json" }, body: JSON.stringify({ enabled }) }));
const getMatches = (cookie: string, q = "") => matchesRoute(new Request(BASE + "/api/seller/youtube/live/chat-matches" + q, { headers: { host: "localhost:3000", cookie } }));

// 진행 중 유튜브 방송(자동 시작까지) 하나를 만든다
async function liveShop() {
  const s = await shop();
  const yt = fakeYoutube();
  yt.video(VID_A, CH_A);
  yt.goLive(VID_A);
  await connectLive(db, s.ctx, yt.client, VID_A, NOW);
  const link = await db.youtubeLiveLink.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } });
  return { ...s, yt, link, cookie: await cookieOf(s.owner.email) };
}

describe("채팅 수집", () => {
  it("켜지 않으면 부르지 않는다(할당량 0), 켜면 고지 문구와 함께 수집한다", async () => {
    const s = await liveShop();
    s.yt.calls.length = 0;
    expect(await collectChats(db, s.yt.client, NOW)).toEqual({ polled: 0, saved: 0 });
    expect(s.yt.calls).toEqual([]);

    expect((await putChat(s.cookie, "yes")).status).toBe(400);
    const on = await putChat(s.cookie, true);
    expect(await on.json()).toEqual({ chatEnabled: true, notice: CHAT_NOTICE });
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "youtube.chat.enable" } })).toBe(1);

    s.yt.chatPages.push({ messages: [msg("m1", "닉네임1"), msg("m2", "다른사람")], nextPageToken: "p2", pollingIntervalMillis: 3_000, ended: false });
    expect(await collectChats(db, s.yt.client, NOW)).toEqual({ polled: 1, saved: 2 });
    const link = await db.youtubeLiveLink.findUniqueOrThrow({ where: { id: s.link.id } });
    expect(link).toMatchObject({ chatPageToken: "p2", chatIntervalMs: 20_000 });
    expect(link.chatNextPollAt?.getTime()).toBe(NOW.getTime() + 20_000);
    // 5단위, 판매자 몫에도 센다
    const usage = await db.youtubeQuotaUsage.findMany({ where: { day: quotaDay(NOW) } });
    expect(Object.fromEntries(usage.map((u) => [u.scope, u.units]))).toMatchObject({ [s.seller.id]: 6 });

    // 간격 전에는 부르지 않고, 지나면 다음 페이지 토큰으로 이어 받는다. 같은 메시지는 한 번만 저장.
    s.yt.calls.length = 0;
    await collectChats(db, s.yt.client, new Date(NOW.getTime() + 10_000));
    expect(s.yt.calls).toEqual([]);
    s.yt.chatPages.push({ messages: [msg("m2", "다른사람")], nextPageToken: "p3", pollingIntervalMillis: 3_000, ended: false });
    expect(await collectChats(db, s.yt.client, new Date(NOW.getTime() + 20_000))).toEqual({ polled: 1, saved: 0 });
    expect(s.yt.chatTokens.at(-1)).toBe("p2");
    expect(await db.youtubeChatMessage.count({ where: { sellerId: s.seller.id } })).toBe(2);
    // 새 메시지가 없으면 간격을 늘린다
    expect((await db.youtubeLiveLink.findUniqueOrThrow({ where: { id: s.link.id } })).chatIntervalMs).toBe(40_000);
  });

  it("채팅이 끝나면 그 방송 수집을 멈추고, 끄면 다시 부르지 않는다", async () => {
    const s = await liveShop();
    await putChat(s.cookie, true);
    s.yt.chatPages.push({ messages: [], nextPageToken: null, pollingIntervalMillis: null, ended: true });
    await collectChats(db, s.yt.client, NOW);
    expect((await db.youtubeLiveLink.findUniqueOrThrow({ where: { id: s.link.id } })).liveChatId).toBeNull();
    s.yt.calls.length = 0;
    await collectChats(db, s.yt.client, new Date(NOW.getTime() + 60_000));
    expect(s.yt.calls).toEqual([]);

    const t = await liveShop();
    await putChat(t.cookie, true);
    await putChat(t.cookie, false);
    t.yt.calls.length = 0;
    await collectChats(db, t.yt.client, NOW);
    expect(t.yt.calls).toEqual([]);
  });

  it("할당량 95%면 수집하지 않는다(방송 상태 확인은 계속)", async () => {
    const s = await liveShop();
    await putChat(s.cookie, true);
    await db.youtubeQuotaUsage.upsert({ where: { day_scope: { day: quotaDay(NOW), scope: "all" } }, create: { day: quotaDay(NOW), scope: "all", units: 9_500 }, update: { units: 9_500 } });
    s.yt.calls.length = 0;
    expect(await collectChats(db, s.yt.client, NOW)).toEqual({ polled: 0, saved: 0, stopped: "quota_exhausted" });
    await syncYoutube(db, s.yt.client, NOW);
    expect(s.yt.calls).toEqual(["videos.list"]);
  });

  it("타이머 한 번: 상태 확인을 건너뛰는 틱(10초)은 채팅만 부른다", async () => {
    const s = await liveShop();
    await putChat(s.cookie, true);
    s.yt.calls.length = 0;
    expect(await runYoutubeSyncOnce(db, s.yt.client, NOW, { status: false })).toMatchObject({ status: null, chat: { polled: 1 } });
    expect(s.yt.calls).toEqual(["liveChatMessages.list"]);
    s.yt.calls.length = 0;
    await runYoutubeSyncOnce(db, s.yt.client, new Date(NOW.getTime() + 60_000));
    expect(s.yt.calls).toEqual(["videos.list", "liveChatMessages.list"]);
  });

  it("같은 방송을 두 판매자가 연결해도 채팅은 판매자마다 저장된다", async () => {
    const a = await liveShop();
    const b = await shop();
    await connectLive(db, b.ctx, a.yt.client, VID_A, NOW);
    const bCookie = await cookieOf(b.owner.email);
    await putChat(a.cookie, true);
    await putChat(bCookie, true);
    const page = { messages: [msg("same1", "닉네임1")], nextPageToken: "p2", pollingIntervalMillis: 3_000, ended: false };
    a.yt.chatPages.push(page, { ...page });
    expect(await collectChats(db, a.yt.client, NOW)).toEqual({ polled: 2, saved: 2 });
    expect(await db.youtubeChatMessage.count({ where: { sellerId: a.seller.id, messageId: "same1" } })).toBe(1);
    expect(await db.youtubeChatMessage.count({ where: { sellerId: b.seller.id, messageId: "same1" } })).toBe(1);
  });

  it("방송이 없으면 켤 수 없다", async () => {
    const s = await shop();
    const res = await putChat(await cookieOf(s.owner.email), true);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_active_live" });
  });

  it("30일 지난 채팅은 지운다", async () => {
    const s = await liveShop();
    await db.youtubeChatMessage.createMany({
      data: [
        { ...msg("old", "a"), sellerId: s.seller.id, liveLinkId: s.link.id, createdAt: new Date(NOW.getTime() - 31 * 86_400_000) },
        { ...msg("new", "b"), sellerId: s.seller.id, liveLinkId: s.link.id, createdAt: new Date(NOW.getTime() - 29 * 86_400_000) },
      ],
    });
    expect(await purgeOldChats(db, NOW)).toBe(1);
    expect((await db.youtubeChatMessage.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { messageId: true } })).map((m) => m.messageId)).toEqual(["new"]);
  });
});

describe("채팅 닉네임 매칭", () => {
  async function order(sellerId: string, nickname: string, createdAt: Date) {
    const grade = await db.memberGrade.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId } });
    const buyer = await createBuyer(sellerId, grade.id);
    const last = await db.order.aggregate({ where: { sellerId }, _max: { orderNo: true } });
    return db.order.create({ data: { sellerId, orderNo: (last._max.orderNo ?? 0) + 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: nickname, totalAmount: 1000, createdAt } });
  }

  it("방송 시간 안 주문 닉네임이 채팅에 나왔는지 표시한다(공백·대소문자·@ 무시, 주문은 그대로)", async () => {
    const s = await liveShop();
    const session = await db.broadcastSession.findUniqueOrThrow({ where: { id: s.link.broadcastSessionId! } });
    await db.youtubeChatMessage.createMany({
      data: [msg("c1", "@Mango Kim", new Date(NOW.getTime() + 60_000)), msg("c2", "mangokim", new Date(NOW.getTime() + 120_000)), msg("c3", "구경꾼")].map((m) => ({ ...m, sellerId: s.seller.id, liveLinkId: s.link.id })),
    });
    const inBroadcast = await order(s.seller.id, "MangoKim", new Date(session.startedAt.getTime() + 1_000));
    await order(s.seller.id, "없는닉", new Date(session.startedAt.getTime() + 2_000));
    await order(s.seller.id, "MangoKim", new Date(session.startedAt.getTime() - 3_600_000)); // 방송 전 주문은 빠진다

    const res = await getMatches(s.cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toEqual({ orders: 2, matched: 1, chatAuthors: 2 });
    expect(body.orders[0]).toMatchObject({ orderId: inBroadcast.id, nickname: "MangoKim", matched: true, lastChatAt: new Date(NOW.getTime() + 120_000).toISOString() });
    expect(body.orders[1]).toMatchObject({ nickname: "없는닉", matched: false, lastChatAt: null });
    expect((await db.order.findUniqueOrThrow({ where: { id: inBroadcast.id } })).broadcastNicknameSnapshot).toBe("MangoKim");
    expect((await getMatches(s.cookie, "?broadcastSessionId=nope")).status).toBe(400);
  });

  it("판매자 격리: 다른 판매자의 방송·채팅은 보이지 않는다", async () => {
    const a = await liveShop();
    const b = await shop();
    const bCookie = await cookieOf(b.owner.email);
    const body = await (await getMatches(bCookie, `?broadcastSessionId=${a.link.broadcastSessionId}`)).json();
    expect(body).toMatchObject({ broadcast: null, orders: [] });
    expect((await getMatches(await cookieOf(b.other.email))).status).toBe(403);
  });
});

// SA-057: 채팅 수집 기본값, 이번 달 수집 현황, 보관 채팅 지금 삭제
const hdr = (cookie: string) => ({ host: "localhost:3000", origin: BASE, cookie, "content-type": "application/json" });
const putSettings = (cookie: string, body: unknown) => settingsPut(new Request(BASE + "/api/seller/youtube/settings", { method: "PUT", headers: hdr(cookie), body: JSON.stringify(body) }));
const getSettings = (cookie: string) => settingsGet(new Request(BASE + "/api/seller/youtube/settings", { headers: hdr(cookie) }));
const getUsage = (cookie: string) => usageRoute(new Request(BASE + "/api/seller/youtube/usage", { headers: hdr(cookie) }));
const deleteChats = (cookie: string) => chatsDelete(new Request(BASE + "/api/seller/youtube/chats", { method: "DELETE", headers: hdr(cookie) }));

describe("유튜브 설정·수집 현황·보관 채팅 삭제", () => {
  it("채팅 수집 기본값: 기본 꺼짐, 켜면 새로 연결하는 방송(직접·자동 찾기)에 적용, 다른 판매자에는 영향 없음", async () => {
    const s = await shop();
    const other = await shop();
    const c = await cookieOf(s.owner.email);
    expect(await (await getSettings(c)).json()).toEqual({ chatDefaultEnabled: false });
    expect((await putSettings(c, { chatDefaultEnabled: "on" })).status).toBe(400);
    expect((await putSettings(await cookieOf(s.other.email), { chatDefaultEnabled: true })).status).toBe(403);
    expect(await (await putSettings(c, { chatDefaultEnabled: true })).json()).toEqual({ chatDefaultEnabled: true });
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "youtube.settings.update" } })).toBe(1);
    expect(await (await getSettings(await cookieOf(other.owner.email))).json()).toEqual({ chatDefaultEnabled: false });

    const yt = fakeYoutube();
    yt.video(VID_A, CH_A);
    expect(await connectLive(db, s.ctx, yt.client, VID_A, NOW)).toMatchObject({ ok: true, value: { chatEnabled: true } });
    yt.video(VID_B, CH_B);
    expect(await connectLive(db, other.ctx, yt.client, VID_B, NOW)).toMatchObject({ ok: true, value: { chatEnabled: false } });

    // 자동 찾기도 기본값을 따른다
    const t = await shop();
    await db.youtubeSellerSetting.create({ data: { sellerId: t.seller.id, chatDefaultEnabled: true } });
    await connectChannel(db, t.ctx, yt.client, CH_A, NOW);
    yt.uploads.set("UUa", ["aaaaaaaaaa3"]);
    yt.video("aaaaaaaaaa3", CH_A);
    await syncYoutube(db, yt.client, NOW);
    expect((await db.youtubeLiveLink.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: t.seller.id } })).chatEnabled).toBe(true);
  });

  it("이번 달 수집 현황: 수집 건수·API 사용 단위·한도, 판매자 하루 한도를 넘으면 수집 멈춤 표시", async () => {
    const s = await liveShop();
    const res = await getUsage(s.cookie);
    expect(res.status).toBe(200);
    expect(Object.keys(await res.json()).sort()).toEqual(["collecting", "messages", "month", "stoppedReason", "storedMessages", "units"]);
    expect((await getUsage(await cookieOf(s.other.email))).status).toBe(403);

    // 방송 연결 1단위(NOW 기준 날짜), 2026-10은 31일
    expect(await chatUsage(db, s.ctx, NOW)).toEqual({
      month: "2026-10",
      messages: 0,
      storedMessages: 0,
      units: { month: 1, monthLimit: 3_000 * 31, today: 1, todayLimit: 3_000 },
      collecting: true,
      stoppedReason: null,
    });

    await putChat(s.cookie, true);
    s.yt.chatPages.push({ messages: [msg("u1", "a"), msg("u2", "b")], nextPageToken: "x", pollingIntervalMillis: 3_000, ended: false });
    await collectChats(db, s.yt.client, NOW);
    expect(await chatUsage(db, s.ctx, NOW)).toMatchObject({ messages: 2, storedMessages: 2, units: { month: 6, today: 6 } });

    // 판매자 오늘 한도를 다 쓰면 멈춤으로 보이고 실제로 수집하지 않는다
    await db.youtubeQuotaUsage.update({ where: { day_scope: { day: quotaDay(NOW), scope: s.seller.id } }, data: { units: 3_000 } });
    expect(await chatUsage(db, s.ctx, NOW)).toMatchObject({ collecting: false, stoppedReason: "seller_daily_limit" });
    await db.youtubeLiveLink.update({ where: { id: s.link.id }, data: { chatNextPollAt: null } });
    s.yt.calls.length = 0;
    expect(await collectChats(db, s.yt.client, NOW)).toEqual({ polled: 0, saved: 0 });
    expect(s.yt.calls).toEqual([]);

    // 다른 판매자 현황은 따로
    const b = await shop();
    expect(await chatUsage(db, b.ctx, NOW)).toMatchObject({ messages: 0, storedMessages: 0, units: { month: 0, today: 0 } });
  });

  it("보관 채팅 지금 삭제: 대표자만, 자기 쇼핑몰 채팅만 지우고 로그 추적을 남긴다(이번 달 수집 건수는 유지)", async () => {
    const a = await liveShop();
    const b = await liveShop();
    await putChat(a.cookie, true);
    await putChat(b.cookie, true);
    // 같은 방송의 같은 채팅 2건을 두 판매자가 각자 받는다
    const page = { messages: [msg("d1", "a"), msg("d2", "b")], nextPageToken: "x", pollingIntervalMillis: 3_000, ended: false };
    a.yt.chatPages.push(page, { ...page });
    await collectChats(db, a.yt.client, NOW);

    const runner = await cookieOf(a.runner.email);
    expect((await deleteChats(runner)).status).toBe(403);
    const res = await deleteChats(a.cookie);
    expect(await res.json()).toEqual({ deleted: 2 });
    expect(await db.youtubeChatMessage.count({ where: { sellerId: a.seller.id } })).toBe(0);
    expect(await db.youtubeChatMessage.count({ where: { sellerId: b.seller.id } })).toBe(2);
    const log = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: a.seller.id, action: "youtube.chat.purge" } });
    expect(log.after).toEqual({ deleted: 2 });
    expect(await chatUsage(db, a.ctx, NOW)).toMatchObject({ messages: 2, storedMessages: 0 });
  });
});

describe("채팅 수집 상태(방송 대시보드 띠)", () => {
  it("꺼짐 → 수집 중(마지막 수집 시각) → 비공개 → 방송 종료, 연결이 없으면 null", async () => {
    const none = await shop();
    expect(await chatStatus(db, none.ctx, NOW)).toEqual({ link: null, state: null, reason: null, lastCollectedAt: null });

    const s = await liveShop();
    expect(await chatStatus(db, s.ctx, NOW)).toMatchObject({ link: { videoId: VID_A, status: "live" }, state: "off", reason: "chat_off", lastCollectedAt: null });
    await putChat(s.cookie, true);
    s.yt.chatPages.push({ messages: [msg("s1", "a")], nextPageToken: "x", pollingIntervalMillis: 3_000, ended: false });
    await collectChats(db, s.yt.client, NOW);
    expect(await chatStatus(db, s.ctx, NOW)).toEqual({
      link: { id: s.link.id, videoId: VID_A, broadcastSessionId: s.link.broadcastSessionId, status: "live" },
      state: "collecting",
      reason: null,
      lastCollectedAt: NOW,
    });

    // 비공개(forbidden)로 막히면 unavailable, 마지막 수집 시각은 남는다
    const later = new Date(NOW.getTime() + 60_000);
    s.yt.chatPages.push({ messages: [], nextPageToken: null, pollingIntervalMillis: null, ended: true, endReason: "chat_forbidden" });
    await collectChats(db, s.yt.client, later);
    expect(await chatStatus(db, s.ctx, later)).toMatchObject({ state: "unavailable", reason: "chat_forbidden", lastCollectedAt: NOW });

    // 방송이 끝나면 ended
    s.yt.end(VID_A);
    await syncYoutube(db, s.yt.client, later);
    expect(await chatStatus(db, s.ctx, later)).toMatchObject({ link: { status: "ended" }, state: "ended", reason: "broadcast_ended" });

    // 라우트: 권한·형태
    const res = await chatStatusRoute(new Request(BASE + "/api/seller/youtube/live/chat-status", { headers: hdr(s.cookie) }));
    expect(await res.json()).toMatchObject({ state: "ended", reason: "broadcast_ended" });
    expect((await chatStatusRoute(new Request(BASE + "/api/seller/youtube/live/chat-status", { headers: hdr(await cookieOf(s.other.email)) }))).status).toBe(403);
  });

  it("유튜브 일시 오류·판매자 한도는 일시 중지, 다른 판매자 상태는 따로", async () => {
    const s = await liveShop();
    await putChat(s.cookie, true);
    s.yt.client.chatMessages = async () => {
      throw new (await import("../../lib/server/youtube/client")).YoutubeApiError(500, "backendError");
    };
    await collectChats(db, s.yt.client, NOW);
    expect(await chatStatus(db, s.ctx, NOW)).toMatchObject({ state: "paused", reason: "youtube_error" });

    await db.youtubeQuotaUsage.update({ where: { day_scope: { day: quotaDay(NOW), scope: s.seller.id } }, data: { units: 3_000 } });
    expect(await chatStatus(db, s.ctx, NOW)).toMatchObject({ state: "paused", reason: "seller_daily_limit" });

    const b = await liveShop();
    await putChat(b.cookie, true);
    expect(await chatStatus(db, b.ctx, NOW)).toMatchObject({ link: { id: b.link.id }, state: "collecting" });
  });
});
