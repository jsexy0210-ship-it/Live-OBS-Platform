// 판매자가 넣은 유튜브 주소를 채널·영상 ID로 바꾼다(API 호출 없음).
// 채널: https://www.youtube.com/@핸들, /channel/UC…, @핸들, UC…  영상: watch?v=, youtu.be/, /live/, /shorts/, 11자 ID
export type YoutubeRef = { kind: "video"; videoId: string } | { kind: "channel"; channelId: string } | { kind: "handle"; handle: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^@[A-Za-z0-9._-]{3,30}$/;
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

export function parseYoutubeRef(raw: unknown): YoutubeRef | null {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (!input || input.length > 300) return null;
  if (VIDEO_ID.test(input)) return { kind: "video", videoId: input };
  if (CHANNEL_ID.test(input)) return { kind: "channel", channelId: input };
  if (HANDLE.test(input)) return { kind: "handle", handle: input };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname.toLowerCase() === "youtu.be") return parts.length === 1 && VIDEO_ID.test(parts[0]) ? { kind: "video", videoId: parts[0] } : null;
  if (parts[0] === "watch") {
    const v = url.searchParams.get("v") ?? "";
    return VIDEO_ID.test(v) ? { kind: "video", videoId: v } : null;
  }
  if ((parts[0] === "live" || parts[0] === "shorts") && parts.length === 2) return VIDEO_ID.test(parts[1]) ? { kind: "video", videoId: parts[1] } : null;
  if (parts[0] === "channel" && parts.length >= 2) return CHANNEL_ID.test(parts[1]) ? { kind: "channel", channelId: parts[1] } : null;
  const handle = decodeURIComponent(parts[0] ?? "");
  if (HANDLE.test(handle)) return { kind: "handle", handle };
  return null;
}
