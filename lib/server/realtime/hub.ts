import { Client } from "pg";
import { LIVE_CHANNEL } from "./notify";

// 서버 인스턴스마다 Postgres LISTEN 연결 1개를 두고, 판매자별 SSE 연결에 「바뀌었다 + version」을 나눠 준다.
// LISTEN 연결이 끊겼다가 다시 붙으면 그사이 알림을 잃었을 수 있으므로 모든 연결에 「다시 받기」를 보낸다.

export type HubEvent = { type: "version"; version: number } | { type: "resync" };
type Listener = (e: HubEvent) => void;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class LiveHub {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private retryMs = RECONNECT_MIN_MS;
  private closed = false;
  private everConnected = false;

  constructor(private readonly connectionString: string) {}

  async subscribe(sellerId: string, listener: Listener): Promise<() => void> {
    let set = this.listeners.get(sellerId);
    if (!set) this.listeners.set(sellerId, (set = new Set()));
    set.add(listener);
    await this.ensureConnected();
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sellerId);
    };
  }

  subscriberCount(sellerId: string): number {
    return this.listeners.get(sellerId)?.size ?? 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => undefined);
  }

  private ensureConnected(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });
    client.on("notification", (msg) => {
      if (msg.channel !== LIVE_CHANNEL || !msg.payload) return;
      try {
        const { sellerId, version } = JSON.parse(msg.payload) as { sellerId: string; version: number };
        this.emit(sellerId, { type: "version", version });
      } catch {
        // 형식이 다른 알림은 무시
      }
    });
    client.on("error", () => this.handleDisconnect(client));
    client.on("end", () => this.handleDisconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
    } catch (e) {
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
      throw e;
    }
    this.client = client;
    this.retryMs = RECONNECT_MIN_MS;
    if (this.everConnected) this.emitAll({ type: "resync" });
    this.everConnected = true;
  }

  private handleDisconnect(client: Client) {
    if (this.client !== client) return;
    this.client = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closed || this.listeners.size === 0) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => {
      this.ensureConnected().catch(() => undefined);
    }, wait).unref?.();
  }

  private emit(sellerId: string, e: HubEvent) {
    for (const l of this.listeners.get(sellerId) ?? []) l(e);
  }

  private emitAll(e: HubEvent) {
    for (const set of this.listeners.values()) for (const l of set) l(e);
  }
}

const globalForHub = globalThis as unknown as { liveHub?: LiveHub };

export function liveHub(): LiveHub {
  if (!globalForHub.liveHub) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL이 설정되지 않았어요.");
    globalForHub.liveHub = new LiveHub(url);
  }
  return globalForHub.liveHub;
}
