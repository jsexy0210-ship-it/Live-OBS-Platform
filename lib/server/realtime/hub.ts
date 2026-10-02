import { Client } from "pg";
import { LIVE_CHANNEL } from "./notify";

// 서버 인스턴스마다 Postgres LISTEN 연결 1개를 두고, 판매자별 SSE 연결에 「바뀌었다 + version」을 나눠 준다.
// LISTEN 연결이 끊겼다가 다시 붙으면 그사이 알림을 잃었을 수 있으므로 모든 연결에 「다시 받기」를 보낸다.

export type HubEvent = { type: "version"; version: number } | { type: "resync" };
type Listener = (e: HubEvent) => void;

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// 조용히 끊긴 연결(방화벽·NAT 시간 초과)을 찾으려고 주기적으로 SELECT 1을 보낸다.
export const HEALTH_CHECK_MS = 45_000;
const HEALTH_TIMEOUT_MS = 10_000;

export class LiveHub {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private retryMs = RECONNECT_MIN_MS;
  private closed = false;
  private everConnected = false;
  private health: ReturnType<typeof setInterval> | null = null;

  private readonly healthCheckMs: number;
  private readonly healthTimeoutMs: number;

  constructor(
    private readonly connectionString: string,
    opts: { healthCheckMs?: number; healthTimeoutMs?: number } = {},
  ) {
    this.healthCheckMs = opts.healthCheckMs ?? HEALTH_CHECK_MS;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  }

  // LISTEN 연결이 된 뒤에 돌아온다. 연결에 실패하면 등록한 리스너를 지우고 오류를 던진다(리스너가 남아 쌓이지 않게).
  async subscribe(sellerId: string, listener: Listener): Promise<() => void> {
    let set = this.listeners.get(sellerId);
    if (!set) this.listeners.set(sellerId, (set = new Set()));
    set.add(listener);
    const remove = () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(sellerId) === set) this.listeners.delete(sellerId);
    };
    try {
      await this.ensureConnected();
    } catch (e) {
      remove();
      throw e;
    }
    return remove;
  }

  subscriberCount(sellerId: string): number {
    return this.listeners.get(sellerId)?.size ?? 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHealthCheck();
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
    const client = new Client({ connectionString: this.connectionString, keepAlive: true });
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
    this.startHealthCheck(client);
    if (this.everConnected) this.emitAll({ type: "resync" });
    this.everConnected = true;
  }

  private handleDisconnect(client: Client) {
    if (this.client !== client) return;
    this.client = null;
    this.stopHealthCheck();
    client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private startHealthCheck(client: Client) {
    this.stopHealthCheck();
    this.health = setInterval(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health check timeout")), this.healthTimeoutMs);
      });
      Promise.race([client.query("SELECT 1"), timeout])
        .catch(() => this.handleDisconnect(client))
        .finally(() => clearTimeout(timer));
    }, this.healthCheckMs);
    this.health.unref?.();
  }

  private stopHealthCheck() {
    if (this.health) clearInterval(this.health);
    this.health = null;
  }

  private scheduleReconnect() {
    if (this.closed || this.listeners.size === 0) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => {
      if (this.closed || this.listeners.size === 0) return;
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
    // LISTEN은 PgBouncer transaction 모드에서 동작하지 않으므로 직접 연결 주소가 있으면 그것을 쓴다.
    const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL이 설정되지 않았어요.");
    globalForHub.liveHub = new LiveHub(url);
  }
  return globalForHub.liveHub;
}
