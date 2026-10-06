import { describe, expect, it } from "vitest";
import { readEventJson } from "../../lib/server/events/http";
import { createYoutubeClient } from "../../lib/server/youtube/client";

describe("이벤트 입력·원문 메모리 계약", () => {
  it("chunked 본문도 8KiB를 넘으면 413이며 배열·잘못된 JSON은 400이다", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(8_193))); controller.close(); } });
    const req = new Request("http://localhost/events", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readEventJson(req)).rejects.toMatchObject({ status: 413, code: "request_too_large" });
    for (const body of ["[]", "null", "invalid"]) await expect(readEventJson(new Request("http://localhost/events", { method: "POST", body }))).rejects.toMatchObject({ status: 400 });
    expect(await readEventJson(new Request("http://localhost/events", { method: "POST", body: '{"keyword":"참가"}' }))).toEqual({ keyword: "참가" });
  });
  it("YouTube 원문이 200자 뒤에 이어져도 fullText는 그대로이며 표시 저장 text는 200자다", async () => {
    const raw = "참가" + " ".repeat(210) + "추가";
    const client = createYoutubeClient("test", async () => Response.json({ items: [{ id: "message", snippet: { displayMessage: raw, publishedAt: "2026-10-06T00:00:00Z" }, authorDetails: { displayName: "같은 이름", channelId: "UC" + "1".repeat(22) } }] }));
    const page = await client.chatMessages("chat", null);
    expect(page.messages[0].fullText).toBe(raw);
    expect(Array.from(page.messages[0].text)).toHaveLength(200);
  });
});
