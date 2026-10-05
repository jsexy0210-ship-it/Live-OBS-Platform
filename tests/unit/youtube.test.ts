import { describe, expect, it } from "vitest";
import { YOUTUBE_MESSAGES, liveStatusOf } from "../../lib/server/youtube/call";
import { CHAT_NOTICE, chatStateOf, nextChatInterval, normalizeNickname } from "../../lib/server/youtube/chat";
import { YoutubeApiError, YoutubeQuotaError, createYoutubeClient, youtubeApiKey, type VideoInfo } from "../../lib/server/youtube/client";
import { parseYoutubeRef } from "../../lib/server/youtube/parse";
import { quotaDay, quotaLimits } from "../../lib/server/youtube/quota";

// 유튜브 연동: 주소 해석, API 응답 해석(모의 fetch), 상태 판정, 할당량 날짜, 문구 말투. 실제 호출은 하지 않는다.
const VID = "dQw4w9WgXcQ";
const CH = "UCabcdefghijklmnopqrstuv";

describe("주소 해석", () => {
  it("영상 주소", () => {
    for (const u of [VID, `https://www.youtube.com/watch?v=${VID}&t=1`, `youtu.be/${VID}`, `https://youtube.com/live/${VID}?si=x`, `m.youtube.com/watch?v=${VID}`]) {
      expect(parseYoutubeRef(u), u).toEqual({ kind: "video", videoId: VID });
    }
  });
  it("채널 주소·핸들", () => {
    expect(parseYoutubeRef(`https://www.youtube.com/channel/${CH}`)).toEqual({ kind: "channel", channelId: CH });
    expect(parseYoutubeRef(CH)).toEqual({ kind: "channel", channelId: CH });
    expect(parseYoutubeRef("https://www.youtube.com/@onq.live")).toEqual({ kind: "handle", handle: "@onq.live" });
    expect(parseYoutubeRef("@onq_live")).toEqual({ kind: "handle", handle: "@onq_live" });
  });
  it("다른 사이트·형식 오류는 null", () => {
    for (const u of ["", "https://evil.com/watch?v=" + VID, "https://www.youtube.com/watch?v=short", "youtube.com/results?search_query=x", 3, null, "a".repeat(400)]) {
      expect(parseYoutubeRef(u), String(u)).toBeNull();
    }
  });
});

function fakeFetch(status: number, body: unknown, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("API 응답 해석(모의)", () => {
  it("videos.list → 방송 상태·채팅 ID", async () => {
    const seen: string[] = [];
    const client = createYoutubeClient(
      "KEY",
      fakeFetch(
        200,
        {
          items: [
            {
              id: VID,
              snippet: { channelId: CH, title: "오늘 방송", liveBroadcastContent: "live" },
              liveStreamingDetails: { actualStartTime: "2026-10-05T01:00:00Z", scheduledStartTime: "2026-10-05T00:55:00Z", activeLiveChatId: "chat1" },
            },
          ],
        },
        seen,
      ),
    );
    const [v] = await client.videos([VID]);
    expect(v).toMatchObject({ videoId: VID, channelId: CH, broadcast: "live", isLiveVideo: true, liveChatId: "chat1", actualEndAt: null });
    expect(v.actualStartAt?.toISOString()).toBe("2026-10-05T01:00:00.000Z");
    const u = new URL(seen[0]);
    expect(u.pathname).toBe("/youtube/v3/videos");
    expect(u.searchParams.get("id")).toBe(VID);
  });
  it("채널 핸들 → 업로드 재생목록", async () => {
    const seen: string[] = [];
    const client = createYoutubeClient("KEY", fakeFetch(200, { items: [{ id: CH, snippet: { title: "채널" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] }, seen));
    expect(await client.channel({ handle: "@onq" })).toEqual({ channelId: CH, title: "채널", uploadsPlaylistId: "UU1" });
    expect(new URL(seen[0]).searchParams.get("forHandle")).toBe("@onq");
  });
  it("403 quotaExceeded는 할당량 오류, 그 밖은 API 오류(메시지에 키 없음)", async () => {
    const quota = createYoutubeClient("SECRET", fakeFetch(403, { error: { errors: [{ reason: "quotaExceeded" }] } }));
    await expect(quota.videos([VID])).rejects.toBeInstanceOf(YoutubeQuotaError);
    const bad = createYoutubeClient("SECRET", fakeFetch(400, { error: { errors: [{ reason: "keyInvalid" }] } }));
    const err = await bad.videos([VID]).catch((e) => e);
    expect(err).toBeInstanceOf(YoutubeApiError);
    expect(String(err.message)).not.toContain("SECRET");
  });
  it("search.list를 쓰지 않는다(50개 넘는 묶음은 거부)", async () => {
    const client = createYoutubeClient("KEY", fakeFetch(200, { items: [] }));
    await expect(client.videos(Array.from({ length: 51 }, () => VID))).rejects.toThrow("too_many_ids");
    expect(await client.videos([])).toEqual([]);
  });
});

describe("채팅 응답 해석(모의)", () => {
  it("liveChat/messages → 표시 이름·본문 앞 200자(이모지 반쪽 없이)·다음 토큰", async () => {
    const seen: string[] = [];
    const long = "😀".repeat(250);
    const client = createYoutubeClient(
      "KEY",
      fakeFetch(
        200,
        {
          nextPageToken: "n2",
          pollingIntervalMillis: 4000,
          items: [
            { id: "m1", snippet: { displayMessage: long, publishedAt: "2026-10-05T01:00:00Z" }, authorDetails: { channelId: "UC1", displayName: " 망고 " } },
            { id: "m2", snippet: { displayMessage: "x" }, authorDetails: { displayName: "날짜없음" } },
          ],
        },
        seen,
      ),
    );
    const page = await client.chatMessages("chat1", "n1");
    expect(page).toMatchObject({ nextPageToken: "n2", pollingIntervalMillis: 4000, ended: false });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({ messageId: "m1", authorChannelId: "UC1", authorName: "망고" });
    expect(Array.from(page.messages[0].text)).toHaveLength(200);
    const u = new URL(seen[0]);
    expect(u.pathname).toBe("/youtube/v3/liveChat/messages");
    expect(u.searchParams.get("pageToken")).toBe("n1");
  });
  it("채팅이 끝났거나 꺼졌으면 ended와 이유, 할당량 초과는 오류", async () => {
    const reasons = { liveChatEnded: "chat_ended", liveChatDisabled: "chat_disabled", liveChatNotFound: "chat_not_found", forbidden: "chat_forbidden" };
    for (const [reason, endReason] of Object.entries(reasons)) {
      const c = createYoutubeClient("KEY", fakeFetch(403, { error: { errors: [{ reason }] } }));
      expect(await c.chatMessages("x", null), reason).toMatchObject({ ended: true, endReason });
    }
    // 목록에 없는 사유(예: toString)는 채팅 종료로 보지 않는다
    await expect(createYoutubeClient("KEY", fakeFetch(400, { error: { errors: [{ reason: "toString" }] } })).chatMessages("x", null)).rejects.toBeInstanceOf(YoutubeApiError);
    const q = createYoutubeClient("KEY", fakeFetch(403, { error: { errors: [{ reason: "quotaExceeded" }] } }));
    await expect(q.chatMessages("x", null)).rejects.toBeInstanceOf(YoutubeQuotaError);
  });
  it("조회 간격: 20초 하한, 새 메시지 없으면 2배씩 60초까지, 80% 넘으면 2배", () => {
    expect(nextChatInterval(null, 3_000, 5, 0)).toBe(20_000);
    expect(nextChatInterval(null, 30_000, 5, 0)).toBe(30_000);
    expect(nextChatInterval(20_000, 3_000, 0, 0)).toBe(40_000);
    expect(nextChatInterval(40_000, 3_000, 0, 0)).toBe(60_000);
    expect(nextChatInterval(60_000, 3_000, 0, 0)).toBe(60_000);
    expect(nextChatInterval(null, 3_000, 5, 0.85)).toBe(40_000);
    expect(nextChatInterval(60_000, 3_000, 0, 0.9)).toBe(120_000);
  });
  it("닉네임 비교 정규화", () => {
    expect(normalizeNickname("@Mango Kim")).toBe("mangokim");
    expect(normalizeNickname("ＭＡＮＧＯ")).toBe("mango");
  });
});

describe("채팅 수집 상태", () => {
  const limits = { daily: 10_000, perSeller: 3_000 };
  const ok = { sellerToday: 0, platformRatio: 0 };
  const live = { status: "LIVE", chatEnabled: true, liveChatId: "c", chatStopReason: null };
  it("상태·이유 우선순위", () => {
    expect(chatStateOf({ ...live, status: "ENDED" }, ok, limits)).toEqual({ state: "ended", reason: "broadcast_ended" });
    expect(chatStateOf({ ...live, status: "UNLINKED" }, ok, limits)).toEqual({ state: "ended", reason: "unlinked" });
    expect(chatStateOf({ ...live, chatEnabled: false }, ok, limits)).toEqual({ state: "off", reason: "chat_off" });
    expect(chatStateOf({ ...live, status: "UPCOMING" }, ok, limits)).toEqual({ state: "waiting", reason: "not_started" });
    expect(chatStateOf({ ...live, liveChatId: null, chatStopReason: "chat_ended" }, ok, limits)).toEqual({ state: "ended", reason: "chat_ended" });
    expect(chatStateOf({ ...live, liveChatId: null, chatStopReason: "chat_forbidden" }, ok, limits)).toEqual({ state: "unavailable", reason: "chat_forbidden" });
    expect(chatStateOf({ ...live, liveChatId: null, chatStopReason: "chat_disabled" }, ok, limits)).toEqual({ state: "unavailable", reason: "chat_disabled" });
    expect(chatStateOf({ ...live, liveChatId: null }, ok, limits)).toEqual({ state: "unavailable", reason: "no_live_chat" });
    expect(chatStateOf(live, { sellerToday: 0, platformRatio: 0.95 }, limits)).toEqual({ state: "paused", reason: "platform_limit" });
    expect(chatStateOf(live, { sellerToday: 3_000, platformRatio: 0.5 }, limits)).toEqual({ state: "paused", reason: "seller_daily_limit" });
    expect(chatStateOf({ ...live, chatStopReason: "youtube_error" }, ok, limits)).toEqual({ state: "paused", reason: "youtube_error" });
    expect(chatStateOf(live, ok, limits)).toEqual({ state: "collecting", reason: null });
  });
});

describe("방송 상태 판정", () => {
  const v = (p: Partial<VideoInfo>): VideoInfo => ({
    videoId: VID, channelId: CH, title: "", broadcast: "upcoming", isLiveVideo: true, scheduledStartAt: null, actualStartAt: null, actualEndAt: null, liveChatId: null, ...p,
  });
  it("예정·진행·종료", () => {
    expect(liveStatusOf(v({}))).toBe("UPCOMING");
    expect(liveStatusOf(v({ broadcast: "live", actualStartAt: new Date() }))).toBe("LIVE");
    expect(liveStatusOf(v({ broadcast: "none", actualStartAt: new Date(), actualEndAt: new Date() }))).toBe("ENDED");
    expect(liveStatusOf(v({ broadcast: "none", actualStartAt: new Date() }))).toBe("ENDED");
  });
});

describe("할당량·설정", () => {
  it("날짜는 태평양 시각(구글 초기화 기준)", () => {
    expect(quotaDay(new Date("2026-10-05T06:59:00Z"))).toBe("2026-10-04");
    expect(quotaDay(new Date("2026-10-05T07:01:00Z"))).toBe("2026-10-05");
  });
  it("무료 한도(10,000)를 넘게 올릴 수 없고 낮출 수만 있다", () => {
    expect(quotaLimits({})).toEqual({ daily: 10_000, perSeller: 3_000 });
    expect(quotaLimits({ YOUTUBE_DAILY_QUOTA: "50000", YOUTUBE_SELLER_DAILY_QUOTA: "x" })).toEqual({ daily: 10_000, perSeller: 3_000 });
    expect(quotaLimits({ YOUTUBE_DAILY_QUOTA: "2000", YOUTUBE_SELLER_DAILY_QUOTA: "5000" })).toEqual({ daily: 2_000, perSeller: 2_000 });
  });
  it("키가 없거나 비어 있으면 꺼짐", () => {
    expect(youtubeApiKey({})).toBeNull();
    expect(youtubeApiKey({ YOUTUBE_API_KEY: "  " })).toBeNull();
    expect(youtubeApiKey({ YOUTUBE_API_KEY: "k" })).toBe("k");
  });
});

describe("문구 말투", () => {
  it("파트너스 관리자 문구는 합니다체", () => {
    for (const m of [...Object.values(YOUTUBE_MESSAGES), CHAT_NOTICE]) expect(m, m).not.toMatch(/(요|요\.|요\?)$/);
  });
});
