// YouTube Data API v3 읽기 전용 클라이언트(API 키만). 단위 시험은 fetch를 모의로 넣는다.
// 호출마다 할당량 단위가 정해져 있다(QUOTA_COST). search.list(100단위)는 쓰지 않는다.
// liveChatMessages.list 5단위는 공식 표를 이 환경에서 확인하지 못했다(실제 호출 시험 때 확인, 다르면 이 값만 바꾼다).
export const QUOTA_COST = { "videos.list": 1, "channels.list": 1, "playlistItems.list": 1, "liveChatMessages.list": 5 } as const;
export type YoutubeMethod = keyof typeof QUOTA_COST;

export const VIDEOS_PER_CALL = 50;
const BASE = "https://www.googleapis.com/youtube/v3/";
const PATH: Record<YoutubeMethod, string> = {
  "videos.list": "videos",
  "channels.list": "channels",
  "playlistItems.list": "playlistItems",
  "liveChatMessages.list": "liveChat/messages",
};

export type ChannelInfo = { channelId: string; title: string; uploadsPlaylistId: string };
// broadcast: upcoming(예정)·live(진행)·none(라이브가 아니거나 끝남). liveStreamingDetails가 없으면 라이브 영상이 아니다.
export type VideoInfo = {
  videoId: string;
  channelId: string;
  title: string;
  broadcast: "upcoming" | "live" | "none";
  isLiveVideo: boolean;
  scheduledStartAt: Date | null;
  actualStartAt: Date | null;
  actualEndAt: Date | null;
  liveChatId: string | null;
};

export type ChatMessage = { messageId: string; authorChannelId: string; authorName: string; text: string; publishedAt: Date };
// ended: 채팅이 끝났거나 꺼짐·없음·비공개. 받으면 그 방송의 수집을 멈추고 endReason을 남긴다.
export type ChatEndReason = "chat_ended" | "chat_disabled" | "chat_not_found" | "chat_forbidden";
export type ChatPage = { messages: ChatMessage[]; nextPageToken: string | null; pollingIntervalMillis: number | null; ended: boolean; endReason?: ChatEndReason };

// 할당량 초과(403 quotaExceeded·dailyLimitExceeded). 받으면 그날 호출을 멈춘다.
export class YoutubeQuotaError extends Error {
  constructor() {
    super("youtube_quota_exceeded");
  }
}
// 그 밖 실패(키 오류·네트워크·5xx). 메시지에 키를 넣지 않는다.
export class YoutubeApiError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`youtube_api_error ${status} ${reason}`);
  }
}

export type YoutubeClient = {
  channel(ref: { channelId: string } | { handle: string }): Promise<ChannelInfo | null>;
  latestUploads(playlistId: string, max?: number): Promise<string[]>;
  videos(ids: readonly string[]): Promise<VideoInfo[]>;
  chatMessages(liveChatId: string, pageToken: string | null): Promise<ChatPage>;
};

const CHAT_ENDED: Record<string, ChatEndReason> = {
  liveChatEnded: "chat_ended",
  liveChatDisabled: "chat_disabled",
  liveChatNotFound: "chat_not_found",
  forbidden: "chat_forbidden",
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
// 글자(코드 포인트) 단위로 자른다(이모지 반쪽이 남지 않게)
const cut = (v: string, n: number) => Array.from(v).slice(0, n).join("");
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function createYoutubeClient(apiKey: string, fetchImpl: Fetch = fetch, timeoutMs = 10_000): YoutubeClient {
  async function get(method: YoutubeMethod, params: Record<string, string>): Promise<{ items?: unknown[]; nextPageToken?: unknown; pollingIntervalMillis?: unknown }> {
    const url = new URL(BASE + PATH[method]);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("key", apiKey);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    } catch (e) {
      throw new YoutubeApiError(0, e instanceof Error ? e.name : "network");
    }
    const body = (await res.json().catch(() => ({}))) as { items?: unknown[]; nextPageToken?: unknown; pollingIntervalMillis?: unknown; error?: { errors?: { reason?: string }[] } };
    if (!res.ok) {
      const reason = body.error?.errors?.[0]?.reason ?? "unknown";
      if (res.status === 403 && (reason === "quotaExceeded" || reason === "dailyLimitExceeded")) throw new YoutubeQuotaError();
      throw new YoutubeApiError(res.status, reason);
    }
    return body;
  }

  return {
    async channel(ref) {
      const r = await get("channels.list", { part: "snippet,contentDetails", ...("channelId" in ref ? { id: ref.channelId } : { forHandle: ref.handle }) });
      const c = r.items?.[0] as { id?: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } } | undefined;
      const uploads = c?.contentDetails?.relatedPlaylists?.uploads;
      if (!c?.id || !uploads) return null;
      return { channelId: c.id, title: (c.snippet?.title ?? "").slice(0, 200), uploadsPlaylistId: uploads };
    },
    async latestUploads(playlistId, max = 5) {
      const r = await get("playlistItems.list", { part: "contentDetails", playlistId, maxResults: String(max) });
      return (r.items ?? []).map((i) => str((i as { contentDetails?: { videoId?: unknown } }).contentDetails?.videoId)).filter((v): v is string => !!v);
    },
    async videos(ids) {
      if (ids.length === 0) return [];
      if (ids.length > VIDEOS_PER_CALL) throw new Error("too_many_ids");
      const r = await get("videos.list", { part: "snippet,liveStreamingDetails", id: ids.join(",") });
      return (r.items ?? []).map((raw) => {
        const v = raw as {
          id?: string;
          snippet?: { channelId?: string; title?: string; liveBroadcastContent?: string };
          liveStreamingDetails?: Record<string, unknown>;
        };
        const d = v.liveStreamingDetails;
        const lbc = v.snippet?.liveBroadcastContent;
        return {
          videoId: v.id ?? "",
          channelId: v.snippet?.channelId ?? "",
          title: (v.snippet?.title ?? "").slice(0, 200),
          broadcast: lbc === "upcoming" || lbc === "live" ? lbc : "none",
          isLiveVideo: !!d,
          scheduledStartAt: date(d?.scheduledStartTime),
          actualStartAt: date(d?.actualStartTime),
          actualEndAt: date(d?.actualEndTime),
          liveChatId: str(d?.activeLiveChatId),
        } satisfies VideoInfo;
      });
    },
    async chatMessages(liveChatId, pageToken) {
      let r;
      try {
        r = await get("liveChatMessages.list", { liveChatId, part: "snippet,authorDetails", maxResults: "2000", ...(pageToken ? { pageToken } : {}) });
      } catch (e) {
        if (e instanceof YoutubeApiError && Object.hasOwn(CHAT_ENDED, e.reason)) {
          return { messages: [], nextPageToken: null, pollingIntervalMillis: null, ended: true, endReason: CHAT_ENDED[e.reason] };
        }
        throw e;
      }
      const messages = (r.items ?? []).flatMap((raw) => {
        const m = raw as { id?: string; snippet?: { displayMessage?: string; publishedAt?: string }; authorDetails?: { channelId?: string; displayName?: string } };
        const publishedAt = date(m.snippet?.publishedAt);
        const authorName = m.authorDetails?.displayName?.trim();
        if (!m.id || !publishedAt || !authorName) return [];
        return [
          {
            messageId: m.id,
            authorChannelId: m.authorDetails?.channelId ?? "",
            authorName: cut(authorName, 100),
            text: cut(m.snippet?.displayMessage ?? "", 200),
            publishedAt,
          },
        ];
      });
      const interval = Number(r.pollingIntervalMillis);
      return { messages, nextPageToken: str(r.nextPageToken), pollingIntervalMillis: Number.isFinite(interval) && interval > 0 ? interval : null, ended: false };
    },
  };
}

// 서버 환경변수로만 키를 읽는다. 없으면 기능 꺼짐(연결 안 됨).
export function youtubeApiKey(env: Record<string, string | undefined> = process.env): string | null {
  const k = env.YOUTUBE_API_KEY?.trim();
  return k ? k : null;
}

export function defaultYoutubeClient(): YoutubeClient | null {
  const key = youtubeApiKey();
  return key ? createYoutubeClient(key) : null;
}
