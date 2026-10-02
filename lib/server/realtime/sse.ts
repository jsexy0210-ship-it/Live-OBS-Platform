import { NextResponse } from "next/server";
import type { HubEvent, LiveHub } from "./hub";

// 핑 간격이자 연결 재확인 간격. 테스트에서만 줄인다.
export const SSE_CONFIG = { pingMs: 25_000 };
// 토큰·세션 하나당 동시에 열 수 있는 SSE 수
export const MAX_STREAMS_PER_KEY = 10;

const globalForSse = globalThis as unknown as { sseSlots?: Map<string, number> };
const slots = (globalForSse.sseSlots ??= new Map<string, number>());

export function openStreamCount(key: string): number {
  return slots.get(key) ?? 0;
}

function acquire(key: string): (() => void) | null {
  const n = slots.get(key) ?? 0;
  if (n >= MAX_STREAMS_PER_KEY) return null;
  slots.set(key, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (slots.get(key) ?? 1) - 1;
    if (left <= 0) slots.delete(key);
    else slots.set(key, left);
  };
}

export type SseOptions = {
  sellerId: string;
  // 연결 수를 세는 기준(오버레이 토큰 해시·판매자 세션 id 등). 원문 토큰을 넣지 않는다.
  key: string;
  // 구독(LISTEN)이 된 뒤에 현재 version을 읽는다. 그 사이 변경을 놓치지 않게.
  readVersion: () => Promise<number>;
  // 핑마다 토큰·세션·판매자 상태·권한을 다시 확인한다. false거나 오류면 연결을 닫는다.
  revalidate: () => Promise<boolean>;
  signal: AbortSignal;
};

// 판매자 채널 SSE 응답(docs/ARCHITECTURE.md 6절). 연결 직후 현재 version을 보내 화면이 최신 상태를 다시 받게 한다.
export async function openSse(hub: LiveHub, opts: SseOptions): Promise<Response> {
  const release = acquire(opts.key);
  if (!release) return NextResponse.json({ error: "too_many_streams" }, { status: 429 });

  // 스트림이 열리기 전에 온 이벤트는 모아 두었다가 보낸다.
  const pending: HubEvent[] = [];
  let deliver: (e: HubEvent) => void = (e) => pending.push(e);
  let unsubscribe: () => void;
  let version: number;
  try {
    unsubscribe = await hub.subscribe(opts.sellerId, (e) => deliver(e));
  } catch (e) {
    release();
    throw e;
  }
  try {
    version = await opts.readVersion();
  } catch (e) {
    unsubscribe();
    release();
    throw e;
  }

  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
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

      const ping = setInterval(() => {
        opts
          .revalidate()
          .catch(() => false)
          .then((ok) => (ok ? send(`: ping\n\n`) : cleanup?.()));
      }, SSE_CONFIG.pingMs);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        release();
        cleanup = undefined;
        try {
          controller.close();
        } catch {
          // 이미 닫힘
        }
      };

      send(`retry: 3000\nevent: version\ndata: ${JSON.stringify({ version })}\n\n`);
      for (const e of pending.splice(0)) onEvent(e);
      deliver = onEvent;
      if (opts.signal.aborted) cleanup();
      else opts.signal.addEventListener("abort", () => cleanup?.(), { once: true });
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
