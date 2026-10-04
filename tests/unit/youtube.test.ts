import { describe, expect, it } from "vitest";
import { YOUTUBE_MESSAGES, liveStatusOf } from "../../lib/server/youtube/call";
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
    for (const m of Object.values(YOUTUBE_MESSAGES)) expect(m, m).not.toMatch(/(요|요\.|요\?)$/);
  });
});
