import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as statusRoute } from "../../app/api/seller/youtube/route";
import { PUT as channelRoute } from "../../app/api/seller/youtube/channel/route";
import { GET as summaryRoute } from "../../app/api/seller/broadcast/summary/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { YoutubeQuotaError, type ChannelInfo, type VideoInfo, type YoutubeClient } from "../../lib/server/youtube/client";
import { quotaDay, reserveQuota } from "../../lib/server/youtube/quota";
import { connectChannel, connectLive, findChannelLive, unlinkLive, youtubeStatus } from "../../lib/server/youtube/service";
import { syncYoutube } from "../../lib/server/youtube/sync";
import { startYoutubeWorker } from "../../lib/server/youtube/worker";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

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
  return { client, calls, video, goLive, end, uploads, videos, exceed: () => (quotaExceeded = true) };
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
    expect(await res.json()).toEqual({ configured: false, channel: null, live: null });
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
    const link = await db.youtubeLiveLink.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    expect(link).toMatchObject({ status: "LIVE", autoStarted: true, liveChatId: "chat-" + VID_A });
    const session = await db.broadcastSession.findUniqueOrThrow({ where: { id: link.broadcastSessionId! } });
    expect(session.status).toBe("LIVE");
    const audit = await db.auditLog.findFirstOrThrow({ where: { sellerId: s.seller.id, action: "broadcast.start" } });
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
    expect((await db.youtubeLiveLink.findFirstOrThrow({ where: { sellerId: s.seller.id } })).status).toBe("LIVE");
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
