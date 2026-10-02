import type { HubEvent, LiveHub } from "./hub";

export const PING_INTERVAL_MS = 25_000;

// 판매자 채널 SSE 응답. 연결 직후 현재 version을 보내 화면이 최신 상태를 다시 받게 한다
// (재연결 때마다 전체 상태를 다시 받는 규칙, docs/ARCHITECTURE.md 6절).
export function sseResponse(hub: LiveHub, sellerId: string, currentVersion: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup?.();
        }
      };
      const onEvent = (e: HubEvent) => {
        if (e.type === "version") send(`event: version\ndata: ${JSON.stringify({ version: e.version })}\n\n`);
        else send(`event: resync\ndata: {}\n\n`);
      };

      send(`retry: 3000\nevent: version\ndata: ${JSON.stringify({ version: currentVersion })}\n\n`);
      const unsubscribe = await hub.subscribe(sellerId, onEvent);
      const ping = setInterval(() => send(`: ping\n\n`), PING_INTERVAL_MS);
      cleanup = () => {
        clearInterval(ping);
        unsubscribe();
        cleanup = undefined;
        try {
          controller.close();
        } catch {
          // 이미 닫힘
        }
      };
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", () => cleanup?.(), { once: true });
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
